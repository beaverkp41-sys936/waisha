import { describe, it, expect } from "vitest";
import { nameTokens, namesMatch } from "../src/util/name-match.js";

describe("nameTokens", () => {
  it("uppercases, strips punctuation and legal suffixes", () => {
    expect(nameTokens("Acme Trading Ltd.")).toEqual(["ACME", "TRADING"]);
    expect(nameTokens("acme trading company limited")).toEqual(["ACME", "TRADING"]);
    expect(nameTokens("ACME-TRADING (T) CO.")).toEqual(["ACME", "TRADING", "T"]);
  });

  it("keeps raw tokens when a name is entirely legal suffixes", () => {
    expect(nameTokens("Co Ltd")).toEqual(["CO", "LTD"]);
  });

  it("returns empty for blank input", () => {
    expect(nameTokens("   ---  ")).toEqual([]);
  });
});

describe("namesMatch", () => {
  it("matches across case, punctuation and legal-suffix variants", () => {
    expect(namesMatch("Acme Trading Ltd", "ACME TRADING COMPANY LIMITED")).toBe(true);
    expect(namesMatch("Kilimanjaro Freight Ltd", "Kilimanjaro Freight Limited")).toBe(true);
    expect(namesMatch("john mushi", "JOHN MUSHI")).toBe(true);
  });

  it("matches when one name is token-containment of the other", () => {
    expect(namesMatch("John Mushi", "John Mushi & Sons")).toBe(true);
    expect(namesMatch("John Mushi Transport Co Ltd", "John Mushi")).toBe(true);
  });

  it("does not match on partial word overlap", () => {
    expect(namesMatch("Acme Trading", "Acme Enterprises")).toBe(false);
    expect(namesMatch("Tanzania Trading Co", "Tanzania Freight Ltd")).toBe(false);
    expect(namesMatch("John Mushi", "John Mkono")).toBe(false);
  });

  it("does not match blanks", () => {
    expect(namesMatch("", "Acme")).toBe(false);
    expect(namesMatch("---", "Acme")).toBe(false);
  });

  it("matches a single distinctive token against longer names", () => {
    expect(namesMatch("Acme", "Acme Trading Ltd")).toBe(true);
  });
});
