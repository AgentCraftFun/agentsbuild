// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentCraft Token ($AGENTCRAFT)
/// @notice ERC-20 utility token for the AgentCraft autonomous AI civilization.
/// @dev Deployed on Base L2. Features: trading toggle, max wallet, renounce ownership.
contract AgentCraft {
    // ──────────────────── ERC-20 Storage ────────────────────

    string public constant name     = "AgentCraft";
    string public constant symbol   = "AGENTCRAFT";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ──────────────────── Access Control ────────────────────

    address public owner;
    mapping(address => bool) public hasMinterRole;

    // ──────────────────── Trading Controls ──────────────────

    bool public tradingEnabled;
    uint256 public maxWalletAmount;  // 0 = no limit
    mapping(address => bool) public isExemptFromLimits; // owner, LP pair, router excluded

    // ──────────────────── Events ────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipRenounced(address indexed previousOwner);
    event MinterRoleGranted(address indexed account);
    event MinterRoleRevoked(address indexed account);
    event TradingEnabled();
    event MaxWalletUpdated(uint256 newMax);
    event ExemptFromLimits(address indexed account, bool exempt);

    // ──────────────────── Errors ────────────────────────────

    error NotOwner();
    error NotMinter();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TradingNotEnabled();
    error ExceedsMaxWallet();
    error OwnershipAlreadyRenounced();
    error TradingAlreadyEnabled();

    // ──────────────────── Modifiers ─────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (!hasMinterRole[msg.sender]) revert NotMinter();
        _;
    }

    // ──────────────────── Constructor ───────────────────────

    /// @param _owner Initial contract owner.
    /// @param _totalSupply Total supply to mint to owner (18 decimals).
    /// @param _maxWalletBps Max wallet in basis points (e.g., 200 = 2%). 0 = no limit.
    constructor(address _owner, uint256 _totalSupply, uint256 _maxWalletBps) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        tradingEnabled = false; // Trading starts DISABLED

        // Mint total supply to owner
        if (_totalSupply > 0) {
            totalSupply = _totalSupply;
            balanceOf[_owner] = _totalSupply;
            emit Transfer(address(0), _owner, _totalSupply);
        }

        // Set max wallet (0 = no limit)
        if (_maxWalletBps > 0 && _totalSupply > 0) {
            maxWalletAmount = (_totalSupply * _maxWalletBps) / 10000;
        }

        // Owner is exempt from all limits
        isExemptFromLimits[_owner] = true;

        emit OwnershipTransferred(address(0), _owner);
    }

    // ──────────────────── Trading Controls ──────────────────

    /// @notice Enable trading. Can only be called once. Irreversible.
    /// @dev Call this AFTER adding LP. Once enabled, tokens can be bought/sold.
    function enableTrading() external onlyOwner {
        if (tradingEnabled) revert TradingAlreadyEnabled();
        tradingEnabled = true;
        emit TradingEnabled();
    }

    /// @notice Update max wallet amount. Set to 0 to remove limit.
    /// @param _maxWalletAmount New max wallet in token units (18 decimals).
    function setMaxWalletAmount(uint256 _maxWalletAmount) external onlyOwner {
        maxWalletAmount = _maxWalletAmount;
        emit MaxWalletUpdated(_maxWalletAmount);
    }

    /// @notice Exempt an address from trading and max wallet restrictions.
    /// @dev Use for: LP pair, router, staking contract, team vesting, etc.
    function setExemptFromLimits(address account, bool exempt) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isExemptFromLimits[account] = exempt;
        emit ExemptFromLimits(account, exempt);
    }

    // ──────────────────── Ownership ────────────────────────

    /// @notice Transfer contract ownership to a new address.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        isExemptFromLimits[newOwner] = true;
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Permanently renounce ownership. Cannot be undone.
    /// @dev After renouncing: no more minter changes, no limit changes, no trading toggle.
    function renounceOwnership() external onlyOwner {
        emit OwnershipRenounced(owner);
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    // ──────────────────── ERC-20 Core ───────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert InsufficientAllowance();
            unchecked {
                _approve(from, msg.sender, currentAllowance - amount);
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    // ──────────────────── Mint / Burn ───────────────────────

    /// @notice Mint `amount` tokens to `to`. Only callable by MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn `amount` of caller's tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burn `amount` of `from`'s tokens, deducting from caller's allowance.
    function burnFrom(address from, uint256 amount) external {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert InsufficientAllowance();
            unchecked {
                _approve(from, msg.sender, currentAllowance - amount);
            }
        }
        _burn(from, amount);
    }

    // ──────────────────── Role Management ───────────────────

    function grantMinterRole(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        hasMinterRole[account] = true;
        emit MinterRoleGranted(account);
    }

    function revokeMinterRole(address account) external onlyOwner {
        hasMinterRole[account] = false;
        emit MinterRoleRevoked(account);
    }

    // ──────────────────── ERC-165 ───────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x36372b07;    // ERC-20
    }

    // ──────────────────── Internal ──────────────────────────

    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        // Trading gate: if trading not enabled, only exempt addresses can transfer
        if (!tradingEnabled) {
            if (!isExemptFromLimits[from] && !isExemptFromLimits[to]) {
                revert TradingNotEnabled();
            }
        }

        // Max wallet check (skip for exempt addresses and sells/removals)
        if (maxWalletAmount > 0 && !isExemptFromLimits[to]) {
            if (balanceOf[to] + amount > maxWalletAmount) {
                revert ExceedsMaxWallet();
            }
        }

        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _approve(address _owner, address spender, uint256 amount) internal {
        if (_owner == address(0)) revert ZeroAddress();
        if (spender == address(0)) revert ZeroAddress();
        allowance[_owner][spender] = amount;
        emit Approval(_owner, spender, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (from == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
