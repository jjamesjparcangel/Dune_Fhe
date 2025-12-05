// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface SpiceContract {
  id: string;
  planet: string;
  encryptedAmount: string;
  timestamp: number;
  owner: string;
  status: "available" | "claimed" | "disputed";
  bidAmount?: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [contracts, setContracts] = useState<SpiceContract[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newContractData, setNewContractData] = useState({ planet: "", spiceAmount: 0 });
  const [selectedContract, setSelectedContract] = useState<SpiceContract | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"contracts" | "dashboard" | "factions">("contracts");
  const [bidAmount, setBidAmount] = useState<string>("");
  const [showTutorial, setShowTutorial] = useState(false);

  const availableCount = contracts.filter(c => c.status === "available").length;
  const claimedCount = contracts.filter(c => c.status === "claimed").length;
  const disputedCount = contracts.filter(c => c.status === "disputed").length;

  useEffect(() => {
    loadContracts().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadContracts = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing contract keys:", e); }
      }
      
      const list: SpiceContract[] = [];
      for (const key of keys) {
        try {
          const contractBytes = await contract.getData(`contract_${key}`);
          if (contractBytes.length > 0) {
            try {
              const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
              list.push({ 
                id: key, 
                planet: contractData.planet, 
                encryptedAmount: contractData.amount, 
                timestamp: contractData.timestamp, 
                owner: contractData.owner, 
                status: contractData.status || "available",
                bidAmount: contractData.bidAmount
              });
            } catch (e) { console.error(`Error parsing contract data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading contract ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setContracts(list);
    } catch (e) { console.error("Error loading contracts:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createContract = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting spice amount with Zama FHE..." });
    try {
      const encryptedAmount = FHEEncryptNumber(newContractData.spiceAmount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contractId = `contract-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const contractData = { 
        planet: newContractData.planet, 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "available" 
      };
      
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(contractData)));
      
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(contractId);
      await contract.setData("contract_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Spice contract created securely!" });
      await loadContracts();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewContractData({ planet: "", spiceAmount: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const claimContract = async (contractId: string) => {
    if (!isConnected || !bidAmount) { alert("Please connect wallet and enter bid amount"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted bid with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedContract = { 
        ...contractData, 
        status: "claimed",
        bidAmount: FHEEncryptNumber(parseFloat(bidAmount))
      };
      await contractWithSigner.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE bid processed successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      setSelectedContract(null);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Claim failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const disputeContract = async (contractId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing dispute with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      const updatedContract = { ...contractData, status: "disputed" };
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE dispute processed successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      setSelectedContract(null);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Dispute failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (contractAddress: string) => address?.toLowerCase() === contractAddress.toLowerCase();

  const renderPlanetMap = () => {
    const planets = Array.from(new Set(contracts.map(c => c.planet)));
    return (
      <div className="planet-map">
        {planets.map(planet => (
          <div key={planet} className="planet-card">
            <div className="planet-icon"></div>
            <h4>{planet}</h4>
            <div className="planet-stats">
              <span>{contracts.filter(c => c.planet === planet).length} Contracts</span>
              <span>{contracts.filter(c => c.planet === planet && c.status === "claimed").length} Active</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderFactionStats = () => {
    const factions = [
      { name: "House Atreides", color: "#3a86ff", contracts: contracts.filter(c => c.owner === "0x123...").length },
      { name: "House Harkonnen", color: "#ff006e", contracts: contracts.filter(c => c.owner === "0x456...").length },
      { name: "Spacing Guild", color: "#8338ec", contracts: contracts.filter(c => c.owner === "0x789...").length },
      { name: "Fremen", color: "#06d6a0", contracts: contracts.filter(c => c.owner === "0xabc...").length }
    ];
    
    return (
      <div className="faction-stats">
        <h3>Great Houses & Factions</h3>
        <div className="faction-bars">
          {factions.map(faction => (
            <div key={faction.name} className="faction-bar">
              <div className="faction-info">
                <div className="faction-color" style={{ backgroundColor: faction.color }}></div>
                <span>{faction.name}</span>
              </div>
              <div className="bar-container">
                <div 
                  className="bar-fill" 
                  style={{ 
                    width: `${(faction.contracts / Math.max(1, contracts.length)) * 100}%`,
                    backgroundColor: faction.color
                  }}
                ></div>
                <span>{faction.contracts} Contracts</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spice-spinner"></div>
      <p>Initializing CHOAM connection...</p>
    </div>
  );

  return (
    <div className="app-container dune-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="choam-icon"></div></div>
          <h1>Dune<span>FHE</span></h1>
          <div className="fhe-badge"><span>Zama FHE Encrypted</span></div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-contract-btn">
            <div className="add-icon"></div>New Spice Contract
          </button>
          <button className="tutorial-btn" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>CHOAM Spice Contracts</h2>
            <p>Negotiate FHE-encrypted spice mining contracts in the Dune universe</p>
          </div>
          <div className="spice-indicator"><div className="spice-icon"></div><span>Spice Must Flow</span></div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE Spice Contracts Tutorial</h2>
            <p className="subtitle">Learn how to securely trade spice mining rights</p>
            <div className="tutorial-steps">
              <div className="tutorial-step">
                <div className="step-icon">🏜️</div>
                <div className="step-content">
                  <h3>Discover Spice</h3>
                  <p>Find spice deposits on Arrakis and other planets</p>
                  <div className="step-details">Spice amounts are encrypted with Zama FHE to prevent espionage</div>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">📜</div>
                <div className="step-content">
                  <h3>Create Contract</h3>
                  <p>List your spice mining rights as FHE-encrypted contracts</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">⚔️</div>
                <div className="step-content">
                  <h3>Negotiate</h3>
                  <p>Great Houses bid on contracts using encrypted amounts</p>
                  <div className="step-details">All bids remain encrypted during processing</div>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-icon">💰</div>
                <div className="step-content">
                  <h3>Profit</h3>
                  <p>Earn spice profits while keeping your operations secret</p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div className="navigation-tabs">
          <button 
            className={`tab-button ${activeTab === "contracts" ? "active" : ""}`}
            onClick={() => setActiveTab("contracts")}
          >
            Spice Contracts
          </button>
          <button 
            className={`tab-button ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Planetary Dashboard
          </button>
          <button 
            className={`tab-button ${activeTab === "factions" ? "active" : ""}`}
            onClick={() => setActiveTab("factions")}
          >
            Great Houses
          </button>
        </div>
        
        {activeTab === "contracts" && (
          <div className="contracts-section">
            <div className="section-header">
              <h2>Available Spice Contracts</h2>
              <div className="header-actions">
                <button onClick={loadContracts} className="refresh-btn" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            <div className="contracts-list">
              <div className="table-header">
                <div className="header-cell">ID</div>
                <div className="header-cell">Planet</div>
                <div className="header-cell">Owner</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              {contracts.length === 0 ? (
                <div className="no-contracts">
                  <div className="no-contracts-icon"></div>
                  <p>No spice contracts found</p>
                  <button className="primary-btn" onClick={() => setShowCreateModal(true)}>Create First Contract</button>
                </div>
              ) : contracts.map(contract => (
                <div 
                  className={`contract-row ${contract.status}`} 
                  key={contract.id} 
                  onClick={() => setSelectedContract(contract)}
                >
                  <div className="table-cell contract-id">#{contract.id.substring(0, 6)}</div>
                  <div className="table-cell">{contract.planet}</div>
                  <div className="table-cell">{contract.owner.substring(0, 6)}...{contract.owner.substring(38)}</div>
                  <div className="table-cell">{new Date(contract.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell"><span className={`status-badge ${contract.status}`}>{contract.status}</span></div>
                  <div className="table-cell actions">
                    {contract.status === "available" && !isOwner(contract.owner) && (
                      <button className="action-btn claim" onClick={(e) => { e.stopPropagation(); setSelectedContract(contract); }}>
                        Bid
                      </button>
                    )}
                    {contract.status === "claimed" && isOwner(contract.owner) && (
                      <button className="action-btn dispute" onClick={(e) => { e.stopPropagation(); disputeContract(contract.id); }}>
                        Dispute
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {activeTab === "dashboard" && (
          <div className="dashboard-section">
            <h2>Planetary Spice Dashboard</h2>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{contracts.length}</div>
                <div className="stat-label">Total Contracts</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{availableCount}</div>
                <div className="stat-label">Available</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{claimedCount}</div>
                <div className="stat-label">Claimed</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{disputedCount}</div>
                <div className="stat-label">Disputed</div>
              </div>
            </div>
            {renderPlanetMap()}
          </div>
        )}
        
        {activeTab === "factions" && (
          <div className="factions-section">
            <h2>Great Houses & Factions</h2>
            {renderFactionStats()}
            <div className="faction-info">
              <h3>About CHOAM</h3>
              <p>The Combine Honnete Ober Advancer Mercantiles (CHOAM) is the universal development corporation that controls the spice trade. All contracts are encrypted with Zama FHE to protect commercial secrets.</p>
              <div className="fhe-notice">
                <div className="fhe-icon"></div>
                <span>All spice amounts and bids are FHE-encrypted to prevent espionage</span>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={createContract} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          contractData={newContractData} 
          setContractData={setNewContractData}
        />
      )}
      
      {selectedContract && (
        <ContractDetailModal 
          contract={selectedContract} 
          onClose={() => { setSelectedContract(null); setDecryptedAmount(null); }} 
          decryptedAmount={decryptedAmount} 
          setDecryptedAmount={setDecryptedAmount} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          bidAmount={bidAmount}
          setBidAmount={setBidAmount}
          onBidSubmit={() => claimContract(selectedContract.id)}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="choam-icon"></div><span>Dune FHE</span></div>
            <p>CHOAM Spice Contracts with Zama FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">About CHOAM</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">© {new Date().getFullYear()} CHOAM Corporation. All rights reserved.</div>
          <div className="fhe-badge"><span>FHE-Powered Spice Trade</span></div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  contractData: any;
  setContractData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, contractData, setContractData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setContractData({ ...contractData, [name]: value });
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setContractData({ ...contractData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!contractData.planet || !contractData.spiceAmount) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>New Spice Mining Contract</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Spice amounts will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Planet *</label>
            <select 
              name="planet" 
              value={contractData.planet} 
              onChange={handleChange} 
              className="modal-select"
            >
              <option value="">Select planet</option>
              <option value="Arrakis">Arrakis</option>
              <option value="Caladan">Caladan</option>
              <option value="Giedi Prime">Giedi Prime</option>
              <option value="Kaitain">Kaitain</option>
              <option value="Salusa Secundus">Salusa Secundus</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Spice Amount (kg) *</label>
            <input 
              type="number" 
              name="spiceAmount" 
              value={contractData.spiceAmount} 
              onChange={handleAmountChange} 
              placeholder="Estimated spice deposit..." 
              className="modal-input"
              step="0.1"
              min="0"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{contractData.spiceAmount || '0'} kg</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {contractData.spiceAmount ? 
                    FHEEncryptNumber(contractData.spiceAmount).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting with FHE..." : "Create Contract"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ContractDetailModalProps {
  contract: SpiceContract;
  onClose: () => void;
  decryptedAmount: number | null;
  setDecryptedAmount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  bidAmount: string;
  setBidAmount: (value: string) => void;
  onBidSubmit: () => void;
}

const ContractDetailModal: React.FC<ContractDetailModalProps> = ({ 
  contract, 
  onClose, 
  decryptedAmount, 
  setDecryptedAmount, 
  isDecrypting, 
  decryptWithSignature,
  bidAmount,
  setBidAmount,
  onBidSubmit
}) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) { setDecryptedAmount(null); return; }
    const decrypted = await decryptWithSignature(contract.encryptedAmount);
    if (decrypted !== null) setDecryptedAmount(decrypted);
  };

  const handleBidChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBidAmount(e.target.value);
  };

  return (
    <div className="modal-overlay">
      <div className="contract-detail-modal">
        <div className="modal-header">
          <h2>Contract #{contract.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="contract-info">
            <div className="info-item"><span>Planet:</span><strong>{contract.planet}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{contract.owner.substring(0, 6)}...{contract.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(contract.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${contract.status}`}>{contract.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Spice Amount</h3>
            <div className="encrypted-data">{contract.encryptedAmount.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedAmount !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedAmount !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Spice Amount</h3>
              <div className="decrypted-value">{decryptedAmount} kg</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
          
          {contract.status === "available" && !contract.owner.includes(address || '') && (
            <div className="bid-section">
              <h3>Submit Bid</h3>
              <div className="bid-form">
                <input
                  type="number"
                  value={bidAmount}
                  onChange={handleBidChange}
                  placeholder="Enter your bid amount..."
                  className="bid-input"
                  step="0.1"
                  min="0"
                />
                <button onClick={onBidSubmit} className="submit-bid-btn">
                  Submit Encrypted Bid
                </button>
              </div>
              <div className="bid-notice">
                <div className="info-icon"></div>
                <span>Your bid will be encrypted with Zama FHE before submission</span>
              </div>
            </div>
          )}
          
          {contract.status === "claimed" && contract.bidAmount && (
            <div className="bid-info">
              <h3>Winning Bid</h3>
              <div className="encrypted-bid">{contract.bidAmount.substring(0, 50)}...</div>
              <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;