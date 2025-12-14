
import { Contract, formatUnits, formatEther, Wallet } from 'ethers';
import type { AbstractSigner } from 'ethers'; // v5 type? AbstractSigner exists in v5 but usually just Signer is fine.

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/**
 * Gets USDC balance.
 */
export async function getUsdBalanceApprox(
  signer: Wallet | any,
  usdcContractAddress: string,
): Promise<number> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error('Wallet/Signer provider is required');
  }
  
  // Safely resolve address
  const address = await signer.getAddress();

  const usdcContract = new Contract(usdcContractAddress, USDC_ABI, provider);
  const balance = await usdcContract.balanceOf(address);
  return parseFloat(formatUnits(balance, 6));
}

/**
 * Gets Native Token (POL/ETH) balance.
 */
export async function getPolBalance(signer: Wallet | any): Promise<number> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error('Wallet/Signer provider is required');
  }
  
  const address = await signer.getAddress();
  
  const balance = await provider.getBalance(address);
  return parseFloat(formatEther(balance));
}
