pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DuneFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => euint32) public encryptedSpiceInBatch;
    mapping(uint256 => uint256) public submissionsInBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event SpiceSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedSpice);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalSpice);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastTime) {
        if (block.timestamp < _lastTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1; // Start with batch 1
        _openBatch(currentBatchId);
        cooldownSeconds = 60; // Default cooldown of 60 seconds
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert PausedState(); // Revert if already unpaused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        _closeBatch(currentBatchId);
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        isBatchOpen[batchId] = true;
        encryptedSpiceInBatch[batchId] = FHE.asEuint32(0); // Initialize to encrypted zero
        submissionsInBatch[batchId] = 0;
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) internal {
        if (!isBatchOpen[batchId]) revert InvalidBatchId();
        isBatchOpen[batchId] = false;
        emit BatchClosed(batchId);
    }

    function submitEncryptedSpice(uint256 batchId, euint32 encryptedSpice)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastSubmissionTime)
    {
        if (!isBatchOpen[batchId]) revert BatchClosedOrNonExistent();
        if (!encryptedSpice.isInitialized()) revert("Submitted spice not initialized");

        encryptedSpiceInBatch[batchId] = encryptedSpiceInBatch[batchId].add(encryptedSpice);
        submissionsInBatch[batchId]++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit SpiceSubmitted(msg.sender, batchId, encryptedSpice.toBytes32());
    }

    function requestBatchDecryption(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastDecryptionRequestTime)
    {
        if (submissionsInBatch[batchId] == 0) {
            revert("No submissions in batch");
        }

        euint32 finalEncryptedSpice = encryptedSpiceInBatch[batchId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = finalEncryptedSpice.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // @dev Replay protection: ensure this callback is processed only once.
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // @dev State verification: ensure the contract state relevant to this decryption request
        // has not changed since the request was made. This prevents using a valid proof for an outdated state.
        DecryptionContext memory ctx = decryptionContexts[requestId];
        euint32 currentEncryptedSpice = encryptedSpiceInBatch[ctx.batchId];
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = currentEncryptedSpice.toBytes32();
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // @dev Proof verification: ensure the decryption proof is valid and signed by the FHEVM key.
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts
        uint256 totalSpice = abi.decode(cleartexts, (uint256));

        ctx.processed = true;
        decryptionContexts[requestId] = ctx; // Update storage to mark as processed

        emit DecryptionCompleted(requestId, ctx.batchId, totalSpice);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage e) internal {
        if (!e.isInitialized()) {
            e = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 storage e) internal view {
        if (!e.isInitialized()) {
            revert("Encrypted value not initialized");
        }
    }
}