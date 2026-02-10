import { describe, it, expect } from "vitest";
import { classifyTransaction } from "../parse-libro-mayor";

describe("classifyTransaction", () => {
  // Transfers and starting balances → "other"
  it('returns "other" for CC2CR transfers', () => {
    expect(classifyTransaction("5.1.1.1.01", "CC2CR-001")).toBe("other");
  });

  it('returns "other" for SALDO starting balances', () => {
    expect(classifyTransaction("1.1.1.2.01", "SALDO-INIT")).toBe("other");
  });

  // Cash
  it('returns "cash" for banco principal account', () => {
    expect(classifyTransaction("1.1.1.2.01", "ING-001")).toBe("cash");
  });

  // Expenses
  it('returns "expense" for account code starting with 5', () => {
    expect(classifyTransaction("5.1.1.1.01", "GAS-001")).toBe("expense");
  });

  it('returns "expense" for account code starting with 6', () => {
    expect(classifyTransaction("6.1.2.3.04", "GAS-002")).toBe("expense");
  });

  it('returns "expense" for land acquisition code 1.2.2.1.01', () => {
    expect(classifyTransaction("1.2.2.1.01", "GAS-003")).toBe("expense");
  });

  it('returns "expense" for loan repayment code 2.1.6.1.01', () => {
    expect(classifyTransaction("2.1.6.1.01", "GAS-004")).toBe("expense");
  });

  // Revenue
  it('returns "revenue" for account 4.x.x with ING entry', () => {
    expect(classifyTransaction("4.1.1.1.01", "ING-001")).toBe("revenue");
  });

  it('returns "revenue" for account 2.x.x with ING entry', () => {
    expect(classifyTransaction("2.1.1.1.01", "ING-001")).toBe("revenue");
  });

  it('returns "revenue" for 4.1.1.1.01 regardless of asiento', () => {
    expect(classifyTransaction("4.1.1.1.01", "MISC-001")).toBe("revenue");
  });

  // Other
  it('returns "other" for unmatched account codes', () => {
    expect(classifyTransaction("3.1.1.1.01", "MISC-001")).toBe("other");
  });

  it('returns "other" for account 2.x.x without ING entry prefix', () => {
    expect(classifyTransaction("2.1.1.1.01", "MISC-001")).toBe("other");
  });
});
