// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline
    ) external;
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin,
        uint256 amountETHMin, address to, uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// @title AgentCraft ($AGENTCRAFT)
/// @notice ERC-20 on Base. Buy/sell tax auto-swapped to ETH for deployer.
contract AgentCraft {
    string public constant name     = "AgentCraft";
    string public constant symbol   = "AGENTCRAFT";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    address payable public taxWallet;
    bool public tradingEnabled;
    uint256 public maxWalletAmount;
    mapping(address => bool) public isExempt;

    // ──────────── Tax ──────────
    uint256 public buyTax  = 10; // percent (10 = 10%)
    uint256 public sellTax = 10;
    uint256 public swapThreshold;  // token amount that triggers auto-swap to ETH
    bool private _inSwap;

    IUniswapV2Router02 public immutable uniswapRouter;
    address public uniswapPair;

    // ──────────── Events ──────────
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed prev, address indexed next_);
    event TradingEnabled();
    event TaxUpdated(uint256 buyTax, uint256 sellTax);
    event TaxSwapped(uint256 tokensSwapped, uint256 ethReceived);

    // ──────────── Errors ──────────
    error NotOwner();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TradingNotEnabled();
    error ExceedsMaxWallet();
    error TaxTooHigh();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier lockSwap() {
        _inSwap = true;
        _;
        _inSwap = false;
    }

    /// @param _totalSupply Total supply in wei (e.g. 1_000_000_000 * 1e18)
    /// @param _maxWalletPct Max wallet % (e.g. 2 = 2%). 0 = no limit.
    /// @param _router Uniswap V2 router address on Base
    constructor(uint256 _totalSupply, uint256 _maxWalletPct, address _router) {
        owner = msg.sender;
        taxWallet = payable(msg.sender);
        tradingEnabled = false;

        // Mint
        totalSupply = _totalSupply;
        balanceOf[msg.sender] = _totalSupply;
        emit Transfer(address(0), msg.sender, _totalSupply);

        // Max wallet
        if (_maxWalletPct > 0) {
            maxWalletAmount = (_totalSupply * _maxWalletPct) / 100;
        }

        // Swap threshold: 0.5% of supply
        swapThreshold = _totalSupply / 200;

        // Uniswap setup
        uniswapRouter = IUniswapV2Router02(_router);
        uniswapPair = IUniswapV2Factory(uniswapRouter.factory())
            .createPair(address(this), uniswapRouter.WETH());

        // Exemptions
        isExempt[msg.sender] = true;
        isExempt[address(this)] = true;
        isExempt[_router] = true;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ──────────── Owner Functions ──────────

    /// @notice Enable trading. Call AFTER adding LP. Irreversible.
    function enableTrading() external onlyOwner {
        tradingEnabled = true;
        emit TradingEnabled();
    }

    /// @notice Set buy and sell tax. Max 10% each. Set both to 0 before renouncing.
    function setTax(uint256 _buyTax, uint256 _sellTax) external onlyOwner {
        if (_buyTax > 10 || _sellTax > 10) revert TaxTooHigh();
        buyTax = _buyTax;
        sellTax = _sellTax;
        emit TaxUpdated(_buyTax, _sellTax);
    }

    /// @notice Set the token threshold that triggers auto-swap to ETH.
    function setSwapThreshold(uint256 _threshold) external onlyOwner {
        swapThreshold = _threshold;
    }

    /// @notice Update the wallet that receives tax ETH.
    function setTaxWallet(address payable _wallet) external onlyOwner {
        if (_wallet == address(0)) revert ZeroAddress();
        taxWallet = _wallet;
    }

    function setExempt(address account, bool exempt) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isExempt[account] = exempt;
    }

    function setMaxWallet(uint256 amount) external onlyOwner {
        maxWalletAmount = amount;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        isExempt[newOwner] = true;
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Permanently renounce. Set tax to 0 first!
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    // ──────────── ERC-20 ──────────

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = a - amount; }
        }
        _transfer(from, to, amount);
        return true;
    }

    // ──────────── Internal ──────────

    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        // Trading gate
        if (!tradingEnabled && !isExempt[from] && !isExempt[to]) {
            revert TradingNotEnabled();
        }

        // Auto-swap accumulated tax tokens to ETH (on sells only, not during swap)
        if (!_inSwap && from != uniswapPair && balanceOf[address(this)] >= swapThreshold) {
            _swapTokensForETH(swapThreshold);
        }

        // Calculate tax
        uint256 taxAmount = 0;
        if (!isExempt[from] && !isExempt[to]) {
            if (from == uniswapPair && buyTax > 0) {
                // Buy
                taxAmount = (amount * buyTax) / 100;
            } else if (to == uniswapPair && sellTax > 0) {
                // Sell
                taxAmount = (amount * sellTax) / 100;
            }
        }

        // Max wallet (skip exempt, skip sells)
        if (maxWalletAmount > 0 && !isExempt[to] && to != uniswapPair) {
            if (balanceOf[to] + amount - taxAmount > maxWalletAmount) revert ExceedsMaxWallet();
        }

        unchecked {
            balanceOf[from] -= amount;
            if (taxAmount > 0) {
                balanceOf[address(this)] += taxAmount; // tax tokens held by contract
                emit Transfer(from, address(this), taxAmount);
            }
            balanceOf[to] += amount - taxAmount;
        }
        emit Transfer(from, to, amount - taxAmount);
    }

    function _swapTokensForETH(uint256 tokenAmount) internal lockSwap {
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = uniswapRouter.WETH();

        allowance[address(this)][address(uniswapRouter)] = tokenAmount;

        uint256 balBefore = address(this).balance;

        uniswapRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokenAmount, 0, path, address(this), block.timestamp
        );

        uint256 ethReceived = address(this).balance - balBefore;
        if (ethReceived > 0) {
            (bool sent,) = taxWallet.call{value: ethReceived}("");
            require(sent);
            emit TaxSwapped(tokenAmount, ethReceived);
        }
    }

    /// @notice Manually trigger a tax swap (if threshold hasn't been hit).
    function manualSwap() external onlyOwner {
        uint256 bal = balanceOf[address(this)];
        if (bal > 0) _swapTokensForETH(bal);
    }

    /// @notice Rescue stuck ETH in contract.
    function rescueETH() external onlyOwner {
        (bool sent,) = taxWallet.call{value: address(this).balance}("");
        require(sent);
    }

    receive() external payable {}
}
