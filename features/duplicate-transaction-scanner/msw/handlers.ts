import { http, HttpResponse } from "msw";
import {
  HASH_A1,
  HASH_A2,
  HASH_B1,
  makeHorizonOperationsPage,
  makeHorizonTransaction,
  TX_A1,
  TX_A2,
  TX_B1,
} from "@/features/duplicate-transaction-scanner/fixtures/scanner.fixture";

const TESTNET = "https://horizon-testnet.stellar.org";

export const handlers = [
  // Transaction A1 — duplicate of A2
  http.get(`${TESTNET}/transactions/${HASH_A1}`, () =>
    HttpResponse.json(makeHorizonTransaction(TX_A1)),
  ),
  http.get(`${TESTNET}/transactions/${HASH_A1}/operations`, () =>
    HttpResponse.json(makeHorizonOperationsPage(TX_A1.operationTypes)),
  ),

  // Transaction A2 — duplicate of A1
  http.get(`${TESTNET}/transactions/${HASH_A2}`, () =>
    HttpResponse.json(makeHorizonTransaction(TX_A2)),
  ),
  http.get(`${TESTNET}/transactions/${HASH_A2}/operations`, () =>
    HttpResponse.json(makeHorizonOperationsPage(TX_A2.operationTypes)),
  ),

  // Transaction B1 — unique (no match)
  http.get(`${TESTNET}/transactions/${HASH_B1}`, () =>
    HttpResponse.json(makeHorizonTransaction(TX_B1)),
  ),
  http.get(`${TESTNET}/transactions/${HASH_B1}/operations`, () =>
    HttpResponse.json(makeHorizonOperationsPage(TX_B1.operationTypes)),
  ),
];

/** A1 transaction returns 404. */
export const notFoundHandler = http.get(
  `${TESTNET}/transactions/${HASH_A1}`,
  () =>
    HttpResponse.json({ title: "Resource Missing", status: 404 }, { status: 404 }),
);

/** A1 transaction returns 429. */
export const rateLimitedHandler = http.get(
  `${TESTNET}/transactions/${HASH_A1}`,
  () =>
    HttpResponse.json({ title: "Too Many Requests", status: 429 }, { status: 429 }),
);
