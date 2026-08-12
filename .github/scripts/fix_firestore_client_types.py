from pathlib import Path

source_path = Path('packages/firestore/src/index.ts')
source = source_path.read_text()

old_interface = """export interface FirestoreLike {
  collection(collectionPath: string): FirestoreCollectionReferenceLike;
  runTransaction<T>(
    updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T>;
}
"""
new_interface = """/**
 * Public structural boundary for an official server-side Firestore client.
 *
 * The callback parameter is deliberately broad because TypeScript cannot
 * structurally assign the SDK's overloaded Transaction methods to the smaller
 * adapter transaction interface through the higher-order runTransaction()
 * signature. Adapter internals narrow the callback back to
 * FirestoreTransactionLike via the private runTransaction() helper.
 */
export interface FirestoreLike {
  collection(collectionPath: string): unknown;
  runTransaction<T>(
    updateFunction: (transaction: any) => Promise<T>,
  ): Promise<T>;
}
"""
if source.count(old_interface) != 1:
    raise SystemExit('FirestoreLike interface match failed')
source = source.replace(old_interface, new_interface, 1)

old_run = 'this.firestore.runTransaction<'
if source.count(old_run) != 4:
    raise SystemExit(f'expected 4 direct runTransaction calls, got {source.count(old_run)}')
source = source.replace(old_run, 'this.runTransaction<')

old_helpers = """  private budgets(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_budgets`);
  }

  private reservations(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_reservations`);
  }
"""
new_helpers = """  private runTransaction<T>(
    updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T> {
    return this.firestore.runTransaction(updateFunction);
  }

  private budgets(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_budgets`) as FirestoreCollectionReferenceLike;
  }

  private reservations(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_reservations`) as FirestoreCollectionReferenceLike;
  }
"""
if source.count(old_helpers) != 1:
    raise SystemExit('collection helper match failed')
source = source.replace(old_helpers, new_helpers, 1)
source_path.write_text(source)


test_path = Path('packages/firestore/src/index.test.ts')
test = test_path.read_text()
old_import = "import type { UsageRequest } from 'mcp-usage-control';\n"
new_import = "import type { UsageRequest } from 'mcp-usage-control';\nimport type { Firestore } from '@google-cloud/firestore';\n"
if test.count(old_import) != 1:
    raise SystemExit('test import match failed')
test = test.replace(old_import, new_import, 1)

marker = """function request(operationId: string, principalId = 'user-a'): UsageRequest {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-a', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

"""
addition = marker + """// Compile-time contract: the official server Firestore client must be accepted
// directly by the adapter constructor without a consumer-side cast.
function assertServerClientTypeCompatibility(firestore: Firestore): void {
  new FirestoreUsageStore(firestore);
}
void assertServerClientTypeCompatibility;

"""
if test.count(marker) != 1:
    raise SystemExit('test insertion marker match failed')
test = test.replace(marker, addition, 1)
test_path.write_text(test)
