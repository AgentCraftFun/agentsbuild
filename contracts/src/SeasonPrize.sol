// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SeasonPrize
/// @notice Collects WORK tokens as a seasonal prize pool and distributes them to
///         top-scoring agents at the end of each season.
contract SeasonPrize {
    // ──────────────────── Storage ───────────────────────────

    address public owner;
    address public server;
    IWORK   public immutable workToken;

    uint256 public currentSeason = 1;

    /// @dev season => total deposited WORK for that season.
    mapping(uint256 => uint256) internal _pool;

    /// @dev season => history record.
    mapping(uint256 => SeasonRecord) internal _history;

    struct SeasonRecord {
        address[] winners;
        uint256[] prizes;
    }

    // ──────────────────── Reentrancy Guard ──────────────────

    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ──────────────────── Events ────────────────────────────

    event PrizeDeposited(uint256 indexed season, address indexed depositor, uint256 amount);
    event SeasonEnded(uint256 indexed season, address[] winners, uint256[] prizes);

    // ──────────────────── Errors ────────────────────────────

    error NotOwner();
    error NotServer();
    error ZeroAddress();
    error ZeroAmount();
    error ArrayLengthMismatch();
    error EmptyArray();
    error ZeroTotalScore();
    error EmptyPool();
    error TransferFailed();

    // ──────────────────── Modifiers ─────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyServer() {
        if (msg.sender != server) revert NotServer();
        _;
    }

    // ──────────────────── Constructor ───────────────────────

    /// @param _workToken Address of the WORK ERC-20 contract.
    /// @param _owner     Initial contract owner.
    constructor(address _workToken, address _owner) {
        if (_workToken == address(0) || _owner == address(0)) revert ZeroAddress();
        workToken = IWORK(_workToken);
        owner  = _owner;
        server = _owner; // default; can be changed
    }

    // ──────────────────── Deposit ───────────────────────────

    /// @notice Deposit WORK into the current season's prize pool.
    /// @dev Caller must have approved this contract to spend `amount` WORK.
    /// @param amount Amount of WORK to deposit (18 decimals).
    function depositPrize(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        bool ok = workToken.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        _pool[currentSeason] += amount;
        emit PrizeDeposited(currentSeason, msg.sender, amount);
    }

    // ──────────────────── End Season ────────────────────────

    /// @notice Finalise the current season and distribute prizes proportionally.
    /// @param agents Array of winning agent addresses.
    /// @param scores Array of corresponding scores.
    function endSeason(
        address[] calldata agents,
        uint256[] calldata scores
    ) external onlyServer nonReentrant {
        if (agents.length == 0) revert EmptyArray();
        if (agents.length != scores.length) revert ArrayLengthMismatch();

        uint256 season = currentSeason;
        uint256 pool   = _pool[season];
        if (pool == 0) revert EmptyPool();

        // Calculate total score
        uint256 totalScore;
        for (uint256 i; i < scores.length;) {
            totalScore += scores[i];
            unchecked { ++i; }
        }
        if (totalScore == 0) revert ZeroTotalScore();

        // Distribute proportionally
        uint256[] memory prizes = new uint256[](agents.length);
        uint256 distributed;

        for (uint256 i; i < agents.length;) {
            uint256 prize = (pool * scores[i]) / totalScore;
            prizes[i] = prize;
            distributed += prize;

            if (prize > 0) {
                bool ok = workToken.transfer(agents[i], prize);
                if (!ok) revert TransferFailed();
            }
            unchecked { ++i; }
        }

        // Any dust (from rounding) stays in the contract for future use.
        // Adjust pool to reflect only undistributed dust.
        _pool[season] = pool - distributed;

        // Record history
        _history[season] = SeasonRecord({winners: agents, prizes: prizes});

        // Advance season
        unchecked {
            currentSeason = season + 1;
        }

        emit SeasonEnded(season, agents, prizes);
    }

    // ──────────────────── Views ─────────────────────────────

    /// @notice WORK balance in the current season's prize pool.
    function currentPool() external view returns (uint256) {
        return _pool[currentSeason];
    }

    /// @notice Retrieve prize-distribution history for a past season.
    function seasonHistory(uint256 season)
        external
        view
        returns (address[] memory winners, uint256[] memory prizes)
    {
        SeasonRecord storage r = _history[season];
        return (r.winners, r.prizes);
    }

    // ──────────────────── Admin ─────────────────────────────

    /// @notice Update the server (SERVER_ROLE) address.
    function setServer(address _server) external onlyOwner {
        if (_server == address(0)) revert ZeroAddress();
        server = _server;
    }

    /// @notice Transfer contract ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ──────────────────── ERC-165 ───────────────────────────

    /// @notice ERC-165 interface detection.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7; // ERC-165
    }
}

// ──────────────────── Minimal Interface ─────────────────────

interface IWORK {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
