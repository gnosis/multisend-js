import { AbiCoder, Interface, ParamType } from '@ethersproject/abi'
import { Provider } from '@ethersproject/abstract-provider'
import { BigNumber, formatFixed } from '@ethersproject/bignumber'
import { Contract } from '@ethersproject/contracts'
import { formatEther } from '@ethersproject/units'

import {
  erc20Interface,
  erc20TransferFragment,
  erc721Interface,
  erc721TransferFragment,
} from './interfaces'
import { MetaTransaction, TransactionInput, TransactionType } from './types'

type AbiFetchFn = (
  contractAddress: string,
  transactionData: string
) => Promise<string | undefined>

export const decodeSingle = async (
  transaction: MetaTransaction,
  provider: Provider,
  fetchAbi?: AbiFetchFn,
  id = ''
): Promise<TransactionInput> => {
  const { to, data, value } = transaction

  if (!data || BigNumber.from(data).isZero()) {
    // ETH transfer
    return {
      type: TransactionType.transferFunds,
      id,
      to,
      amount: formatEther(value).toString(),
      decimals: 18,
      token: null,
    }
  }

  let erc20TransferData = null
  try {
    erc20TransferData = erc20Interface.decodeFunctionData(
      erc20TransferFragment,
      data
    )
  } catch (e) {
    // it's not an ERC20 transfer
  }

  if (erc20TransferData && BigNumber.from(value).isZero()) {
    const decimals = await new Contract(to, erc20Interface, provider).decimals()
    return {
      type: TransactionType.transferFunds,
      id,
      to: erc20TransferData.recipient,
      amount: formatFixed(erc20TransferData.amount, decimals),
      decimals,
      token: to,
    }
  }

  let erc721TransferData = null
  try {
    erc721TransferData = erc721Interface.decodeFunctionData(
      erc721TransferFragment,
      data
    )
  } catch (e) {
    // it's not an ERC721 transfer
  }

  if (erc721TransferData && BigNumber.from(value).isZero()) {
    return {
      type: TransactionType.transferCollectible,
      id,
      from: erc721TransferData._from,
      to: erc721TransferData._to,
      tokenId: erc721TransferData._tokenId.toString(),
      address: to,
    }
  }

  // try to fetch the ABI
  let abi = ''
  if (fetchAbi) {
    try {
      abi = (await fetchAbi(to, data)) || ''
    } catch (e) {
      // could not fetch ABI
    }
  }

  if (abi) {
    const iface = new Interface(abi)
    let fragment
    try {
      fragment = iface.getFunction(data.substring(0, 10).toLowerCase())
    } catch (e) {
      // ignore error if fragment is not found in abi
    }

    if (fragment) {
      return {
        type: TransactionType.callContract,
        id,
        to,
        abi,
        functionSignature: fragment.format(),
        inputValues: decodeArgs(data, fragment.inputs),
        value: BigNumber.from(value || '0x00').toString(),
      }
    }
  }

  return {
    type: TransactionType.raw,
    id,
    to,
    value: BigNumber.from(value || '0x00').toString(),
    data,
  }
}

// we slightly adjust ethers' default coerce function so we return BigNumbers as strings.
const abiCoder = new AbiCoder((name: string, value: unknown) => {
  if (!BigNumber.isBigNumber(value)) return value

  // Return as number if not too big.
  // (This is replicating the ethers' default coerce function.)
  const match = name.match('^u?int([0-9]+)$')
  if (match && parseInt(match[1]) <= 48) {
    return value.toNumber()
  }

  return value.toString()
})

const decodeArgs = (data: string, inputs: ParamType[]) => {
  const result = abiCoder.decode(inputs, '0x' + data.substring(10))

  const keys = Object.keys(result)
  const namedKeys = keys.filter((key) => `${parseInt(key)}` !== key)
  const allArgsHaveNames = namedKeys.length * 2 === keys.length
  const keysToUse = allArgsHaveNames ? namedKeys : keys
  return Object.assign({}, ...keysToUse.map((key) => ({ [key]: result[key] })))
}
