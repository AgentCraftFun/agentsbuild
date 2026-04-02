// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LandRegistry
/// @notice ERC-721 land deed contract for the AgentCraft 200x150 tile world.
/// @dev Token IDs are deterministic tile IDs (0 .. 29 999). Land is purchased by
///      burning $AGENTCRAFT tokens at the biome-specific price.
contract LandRegistry {
    // ──────────────────── Constants ─────────────────────────

    uint256 public constant WORLD_WIDTH  = 200;
    uint256 public constant WORLD_HEIGHT = 150;
    uint256 public constant MAX_TILE_ID  = WORLD_WIDTH * WORLD_HEIGHT; // 30 000 (exclusive)

    // ──────────────────── ERC-721 Metadata ──────────────────

    string public constant name   = "AgentCraft Land";
    string public constant symbol = "ACLAND";

    // ──────────────────── ERC-721 Storage ───────────────────

    /// @dev owner of tokenId; zero means token does not exist.
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _tokenApprovals;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    // ──────────────────── Game Storage ──────────────────────

    address public owner;
    address public server; // SERVER_ROLE — can set biomes

    IAgentCraft public immutable agentCraftToken;

    /// @notice Biome id => price in $AGENTCRAFT (18 decimals).
    mapping(uint8 => uint256) public biomePrice;

    /// @notice Tile id => biome id.
    mapping(uint256 => uint8) public biomeOf;

    /// @notice Tile id => address with build rights (agent).
    mapping(uint256 => address) public agentRights;

    // ──────────────────── Reentrancy Guard ──────────────────

    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ──────────────────── Events ────────────────────────────

    // ERC-721 events
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // Game events
    event TileClaimed(uint256 indexed tileId, address indexed claimedBy);
    event AgentRightsSet(uint256 indexed tileId, address indexed agent);

    // ──────────────────── Errors ────────────────────────────

    error NotOwner();
    error NotServerOrOwner();
    error InvalidTileId();
    error TileAlreadyClaimed();
    error BiomePriceNotSet();
    error ArrayLengthMismatch();
    error ZeroAddress();
    error TokenDoesNotExist();
    error NotOwnerOrApproved();
    error TransferToNonReceiver();
    error ApprovalToOwner();
    error NotTileOwner();

    // ──────────────────── Modifiers ─────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyServerOrOwner() {
        if (msg.sender != server && msg.sender != owner) revert NotServerOrOwner();
        _;
    }

    // ──────────────────── Constructor ───────────────────────

    /// @param _agentCraftToken Address of the $AGENTCRAFT ERC-20 contract.
    /// @param _owner     Initial contract owner.
    constructor(address _agentCraftToken, address _owner) {
        if (_agentCraftToken == address(0) || _owner == address(0)) revert ZeroAddress();
        agentCraftToken = IAgentCraft(_agentCraftToken);
        owner = _owner;
        server = _owner; // default server to owner; can be changed later
    }

    // ──────────────────── Land Claims ───────────────────────

    /// @notice Claim a tile by burning the biome-appropriate $AGENTCRAFT cost.
    /// @param tileId Tile to claim (0 .. 29 999).
    function claim(uint256 tileId) external nonReentrant {
        if (tileId >= MAX_TILE_ID) revert InvalidTileId();
        if (_owners[tileId] != address(0)) revert TileAlreadyClaimed();

        uint8 biome = biomeOf[tileId];
        uint256 price = biomePrice[biome];
        if (price == 0) revert BiomePriceNotSet();

        // Burn $AGENTCRAFT from caller (requires prior approval to this contract)
        agentCraftToken.burnFrom(msg.sender, price);

        // Mint the land deed
        _mint(msg.sender, tileId);

        emit TileClaimed(tileId, msg.sender);
    }

    // ──────────────────── Agent Rights ──────────────────────

    /// @notice Grant build rights on a tile to an agent address.
    /// @param tileId Tile the caller owns.
    /// @param agent  Address to grant rights to (address(0) to revoke).
    function setAgentRights(uint256 tileId, address agent) external {
        if (_owners[tileId] != msg.sender) revert NotTileOwner();
        agentRights[tileId] = agent;
        emit AgentRightsSet(tileId, agent);
    }

    // ──────────────────── Admin ─────────────────────────────

    /// @notice Set biome prices in batch.
    function setBiomePrices(uint8[] calldata biomes, uint256[] calldata prices) external onlyOwner {
        if (biomes.length != prices.length) revert ArrayLengthMismatch();
        for (uint256 i; i < biomes.length;) {
            biomePrice[biomes[i]] = prices[i];
            unchecked { ++i; }
        }
    }

    /// @notice Set (or initialise) the biome for a tile. Server/owner only.
    function setBiome(uint256 tileId, uint8 biome) external onlyServerOrOwner {
        if (tileId >= MAX_TILE_ID) revert InvalidTileId();
        biomeOf[tileId] = biome;
    }

    /// @notice Batch-set biomes for gas efficiency.
    function setBiomeBatch(uint256[] calldata tileIds, uint8[] calldata biomes) external onlyServerOrOwner {
        if (tileIds.length != biomes.length) revert ArrayLengthMismatch();
        for (uint256 i; i < tileIds.length;) {
            if (tileIds[i] >= MAX_TILE_ID) revert InvalidTileId();
            biomeOf[tileIds[i]] = biomes[i];
            unchecked { ++i; }
        }
    }

    /// @notice Update the server address.
    function setServer(address _server) external onlyOwner {
        server = _server;
    }

    /// @notice Transfer contract ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ──────────────────── ERC-721 Core ──────────────────────

    function balanceOf(address _owner) external view returns (uint256) {
        if (_owner == address(0)) revert ZeroAddress();
        return _balances[_owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        return tokenOwner;
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (to == tokenOwner) revert ApprovalToOwner();
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender])
            revert NotOwnerOrApproved();
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "ERC721: self-approval");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address _owner, address operator) public view returns (bool) {
        return _operatorApprovals[_owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotOwnerOrApproved();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotOwnerOrApproved();
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    /// @notice Returns an empty string; metadata is off-chain.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return "";
    }

    // ──────────────────── ERC-165 ───────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x80ac58cd || // ERC-721
            interfaceId == 0x5b5e139f;   // ERC-721 Metadata
    }

    // ──────────────────── Internal ──────────────────────────

    function _mint(address to, uint256 tokenId) internal {
        _owners[tokenId] = to;
        unchecked {
            _balances[to]++;
        }
        emit Transfer(address(0), to, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (ownerOf(tokenId) != from) revert NotOwnerOrApproved();
        if (to == address(0)) revert ZeroAddress();

        // Clear approvals and agent rights on transfer
        delete _tokenApprovals[tokenId];
        delete agentRights[tokenId];

        unchecked {
            _balances[from]--;
            _balances[to]++;
        }
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address tokenOwner = ownerOf(tokenId);
        return (
            spender == tokenOwner ||
            _tokenApprovals[tokenId] == spender ||
            _operatorApprovals[tokenOwner][spender]
        );
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) internal {
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                if (retval != IERC721Receiver.onERC721Received.selector) revert TransferToNonReceiver();
            } catch {
                revert TransferToNonReceiver();
            }
        }
    }
}

// ──────────────────── Minimal Interfaces ────────────────────

interface IAgentCraft {
    function burnFrom(address from, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
