// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentCraft ($AGENTCRAFT)
/// @notice Simple ERC-20 token on Base. Fixed supply, max wallet, trading gate.
contract AgentCraft {
    string public constant name     = "AgentCraft";
    string public constant symbol   = "AGENTCRAFT";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    bool public tradingEnabled;
    uint256 public maxWalletAmount;
    mapping(address => bool) public isExempt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed prev, address indexed next_);
    event TradingEnabled();

    error NotOwner();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TradingNotEnabled();
    error ExceedsMaxWallet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param _totalSupply Total supply in wei (e.g. 1_000_000_000 * 1e18 for 1B tokens)
    /// @param _maxWalletPct Max wallet as percentage (e.g. 2 = 2% of supply). 0 = no limit.
    constructor(uint256 _totalSupply, uint256 _maxWalletPct) {
        owner = msg.sender;
        tradingEnabled = false;

        // Mint entire supply to deployer
        totalSupply = _totalSupply;
        balanceOf[msg.sender] = _totalSupply;
        emit Transfer(address(0), msg.sender, _totalSupply);

        // Max wallet
        if (_maxWalletPct > 0) {
            maxWalletAmount = (_totalSupply * _maxWalletPct) / 100;
        }

        // Deployer exempt from all limits
        isExempt[msg.sender] = true;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ──────────── Trading Controls ──────────

    /// @notice Enable trading. Call AFTER adding LP. One-time, irreversible.
    function enableTrading() external onlyOwner {
        tradingEnabled = true;
        emit TradingEnabled();
    }

    /// @notice Exempt an address from trading gate + max wallet (use for router, LP pair, CEX)
    function setExempt(address account, bool exempt) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isExempt[account] = exempt;
    }

    /// @notice Update max wallet. Set to 0 to remove limit entirely.
    function setMaxWallet(uint256 amount) external onlyOwner {
        maxWalletAmount = amount;
    }

    // ──────────── Ownership ──────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        isExempt[newOwner] = true;
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Permanently renounce ownership. Cannot be undone.
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

        // Max wallet
        if (maxWalletAmount > 0 && !isExempt[to]) {
            if (balanceOf[to] + amount > maxWalletAmount) revert ExceedsMaxWallet();
        }

        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
