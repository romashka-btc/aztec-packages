import { Tx, TxHash } from '@aztec/circuit-types';
import { type TxAddedToPoolStats } from '@aztec/circuit-types/stats';
import { createLogger } from '@aztec/foundation/log';
import { type TelemetryClient } from '@aztec/telemetry-client';

import { PoolInstrumentation, PoolName } from '../instrumentation.js';
import { type TxPool } from './tx_pool.js';

/**
 * In-memory implementation of the Transaction Pool.
 */
export class InMemoryTxPool implements TxPool {
  /**
   * Our tx pool, stored as a Map in-memory, with K: tx hash and V: the transaction.
   */
  private txs: Map<bigint, Tx>;
  private minedTxs: Map<bigint, number>;
  private pendingTxs: Set<bigint>;

  private metrics: PoolInstrumentation<Tx>;

  /**
   * Class constructor for in-memory TxPool. Initiates our transaction pool as a JS Map.
   * @param log - A logger.
   */
  constructor(telemetry: TelemetryClient, private log = createLogger('p2p:tx_pool')) {
    this.txs = new Map<bigint, Tx>();
    this.minedTxs = new Map();
    this.pendingTxs = new Set();
    this.metrics = new PoolInstrumentation(telemetry, PoolName.TX_POOL);
  }

  public markAsMined(txHashes: TxHash[], blockNumber: number): Promise<void> {
    const keys = txHashes.map(x => x.toBigInt());
    for (const key of keys) {
      this.minedTxs.set(key, blockNumber);
      this.pendingTxs.delete(key);
    }
    this.metrics.recordRemovedObjects(txHashes.length, 'pending');
    this.metrics.recordAddedObjects(txHashes.length, 'mined');
    return Promise.resolve();
  }

  public markMinedAsPending(txHashes: TxHash[]): Promise<void> {
    if (txHashes.length === 0) {
      return Promise.resolve();
    }

    const keys = txHashes.map(x => x.toBigInt());
    let deleted = 0;
    let added = 0;
    for (const key of keys) {
      if (this.minedTxs.delete(key)) {
        deleted++;
      }

      // only add back to the pending set if we have the tx object
      if (this.txs.has(key)) {
        added++;
        this.pendingTxs.add(key);
      }
    }

    this.metrics.recordRemovedObjects(deleted, 'mined');
    this.metrics.recordAddedObjects(added, 'pending');

    return Promise.resolve();
  }

  public getPendingTxHashes(): TxHash[] {
    return Array.from(this.pendingTxs).map(x => TxHash.fromBigInt(x));
  }

  public getMinedTxHashes(): [TxHash, number][] {
    return Array.from(this.minedTxs.entries()).map(([txHash, blockNumber]) => [TxHash.fromBigInt(txHash), blockNumber]);
  }

  public getTxStatus(txHash: TxHash): 'pending' | 'mined' | undefined {
    const key = txHash.toBigInt();
    if (this.pendingTxs.has(key)) {
      return 'pending';
    }
    if (this.minedTxs.has(key)) {
      return 'mined';
    }
    return undefined;
  }

  /**
   * Checks if a transaction exists in the pool and returns it.
   * @param txHash - The generated tx hash.
   * @returns The transaction, if found, 'undefined' otherwise.
   */
  public getTxByHash(txHash: TxHash): Tx | undefined {
    const result = this.txs.get(txHash.toBigInt());
    return result === undefined ? undefined : Tx.clone(result);
  }

  /**
   * Adds a list of transactions to the pool. Duplicates are ignored.
   * @param txs - An array of txs to be added to the pool.
   * @returns Empty promise.
   */
  public addTxs(txs: Tx[]): Promise<void> {
    let pending = 0;
    for (const tx of txs) {
      const txHash = tx.getTxHash();
      this.log.verbose(`Adding tx ${txHash.toString()} to pool`, {
        eventName: 'tx-added-to-pool',
        ...tx.getStats(),
      } satisfies TxAddedToPoolStats);

      const key = txHash.toBigInt();
      this.txs.set(key, tx);
      if (!this.minedTxs.has(key)) {
        pending++;
        this.metrics.recordSize(tx);
        this.pendingTxs.add(key);
      }
    }

    this.metrics.recordAddedObjects(pending, 'pending');
    return Promise.resolve();
  }

  /**
   * Deletes transactions from the pool. Tx hashes that are not present are ignored.
   * @param txHashes - An array of tx hashes to be removed from the tx pool.
   * @returns The number of transactions that was deleted from the pool.
   */
  public deleteTxs(txHashes: TxHash[]): Promise<void> {
    let deletedMined = 0;
    let deletedPending = 0;

    for (const txHash of txHashes) {
      const key = txHash.toBigInt();
      this.txs.delete(key);
      deletedPending += this.pendingTxs.delete(key) ? 1 : 0;
      deletedMined += this.minedTxs.delete(key) ? 1 : 0;
    }

    this.metrics.recordRemovedObjects(deletedPending, 'pending');
    this.metrics.recordRemovedObjects(deletedMined, 'mined');

    return Promise.resolve();
  }

  /**
   * Gets all the transactions stored in the pool.
   * @returns Array of tx objects in the order they were added to the pool.
   */
  public getAllTxs(): Tx[] {
    return Array.from(this.txs.values()).map(x => Tx.clone(x));
  }

  /**
   * Gets the hashes of all transactions currently in the tx pool.
   * @returns An array of transaction hashes found in the tx pool.
   */
  public getAllTxHashes(): TxHash[] {
    return Array.from(this.txs.keys()).map(x => TxHash.fromBigInt(x));
  }
}
