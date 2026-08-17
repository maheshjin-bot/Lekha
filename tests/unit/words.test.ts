/**
 * Amount in words. A tax invoice must carry it, and a customer reads the words
 * before the figures — so a wrong conversion is the most visible error the
 * document can contain.
 *
 * The Indian system groups as crore / lakh / thousand, not million / billion.
 */
import { describe, expect, it } from "vitest";
import { amountInWords, numberToWords } from "@/lib/utils/words";

describe("numberToWords", () => {
  it("handles the small cases", () => {
    expect(numberToWords(0)).toBe("Zero");
    expect(numberToWords(7)).toBe("Seven");
    expect(numberToWords(15)).toBe("Fifteen");
    expect(numberToWords(40)).toBe("Forty");
    expect(numberToWords(42)).toBe("Forty Two");
    expect(numberToWords(100)).toBe("One Hundred");
    expect(numberToWords(101)).toBe("One Hundred One");
  });

  it("groups by lakh and crore, not by million", () => {
    expect(numberToWords(1000)).toBe("One Thousand");
    expect(numberToWords(100000)).toBe("One Lakh");
    expect(numberToWords(1000000)).toBe("Ten Lakh");
    expect(numberToWords(10000000)).toBe("One Crore");
    expect(numberToWords(12345678)).toBe(
      "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight"
    );
  });

  it("does not emit empty groups", () => {
    // 1,00,00,001 — no lakh, no thousand, no hundred.
    expect(numberToWords(10000001)).toBe("One Crore One");
    expect(numberToWords(100000)).toBe("One Lakh");
  });
});

describe("amountInWords", () => {
  it("spells rupees and paise separately", () => {
    expect(amountInWords(1000)).toBe("Rupees One Thousand Only");
    expect(amountInWords(1000.5)).toBe("Rupees One Thousand and Fifty Paise Only");
    expect(amountInWords(123045.45)).toBe(
      "Rupees One Lakh Twenty Three Thousand Forty Five and Forty Five Paise Only"
    );
  });

  it("rounds the whole amount before splitting rupees from paise", () => {
    // Flooring the rupees and rounding the remainder separately lets the two
    // disagree — 99.999 produced "Ninety Nine and One Hundred Paise", which is
    // not an amount. The words must agree with the numerals beside them.
    expect(amountInWords(99.999)).toBe("Rupees One Hundred Only");
    expect(amountInWords(0.005)).toBe("Rupees Zero and One Paise Only");
    expect(amountInWords(0.994)).toBe("Rupees Zero and Ninety Nine Paise Only");
    expect(amountInWords(0.996)).toBe("Rupees One Only");
  });

  it("handles zero and negatives", () => {
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(-500)).toBe("Minus Rupees Five Hundred Only");
  });
});
