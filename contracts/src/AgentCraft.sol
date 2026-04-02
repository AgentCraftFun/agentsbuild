// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentCraft Token ($AGENTCRAFT)
/// @notice ERC-20 utility token for the AgentCraft autonomous AI civilization.
/// @dev Deployed on Base L2. Activity-gated emission with no max supply. Only MINTER_ROLE holders can mint.
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

    // ──────────────────── Events ────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MinterRoleGranted(address indexed account);
    event MinterRoleRevoked(address indexed account);

    // ──────────────────── Errors ────────────────────────────

    error NotOwner();
    error NotMinter();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

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

    /// @param _owner Initial contract owner who can grant/revoke MINTER_ROLE.
    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ──────────────────── ERC-20 Core ───────────────────────

    /// @notice Transfer `amount` tokens to `to`.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Approve `spender` to spend `amount` on behalf of caller.
    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    /// @notice Transfer `amount` tokens from `from` to `to`, deducting from caller's allowance.
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
    /// @param to   Recipient address.
    /// @param amount Number of tokens (18-decimal).
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount; // overflow impossible: balance <= totalSupply
        }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn `amount` of caller's tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burn `amount` of `from`'s tokens, deducting from caller's allowance.
    /// @dev Used by LandRegistry / BuildingRegistry to burn on behalf of users.
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

    /// @notice Grant MINTER_ROLE to `account`.
    function grantMinterRole(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        hasMinterRole[account] = true;
        emit MinterRoleGranted(account);
    }

    /// @notice Revoke MINTER_ROLE from `account`.
    function revokeMinterRole(address account) external onlyOwner {
        hasMinterRole[account] = false;
        emit MinterRoleRevoked(account);
    }

    /// @notice Transfer contract ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ──────────────────── ERC-165 ───────────────────────────

    /// @notice Query interface support (ERC-165).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x36372b07;    // ERC-20 (non-standard but commonly used id)
    }

    // ──────────────────── Internal ──────────────────────────

    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount; // overflow impossible: sum of balances == totalSupply
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
