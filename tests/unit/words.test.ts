/**
 * Amount in words. Every bank and assessing officer reads this line, and it is
 * the first thing anyone notices when it disagrees with the figures beside it.
 */
import { describe, expect, it } from "vitest";
import { amountInWords, numberToIndianWords } from "@/lib/utils/words";

describe("numberToIndianWords", () => {
  it("handles the small cases", () => {
    expect(numberToIndianWords(0)).toBe("Zero");
    expect(numberToIndianWords(7)).toBe("Seven");
    expect(numberToIndianWords(15)).toBe("Fifteen");
    expect(numberToIndianWords(20)).toBe("Twenty");
    expect(numberToIndianWords(42)).toBe("Forty Two");
    expect(numberToIndianWords(100)).toBe("One Hundred");
    expect(numberToIndianWords(101)).toBe("One Hundred One");
    expect(numberToIndianWords(999)).toBe("Nine Hundred Ninety Nine");
  });

  it("groups the Indian way, not the western way", () => {
    // The whole point: 100000 is One Lakh, never Hundred Thousand.
    expect(numberToIndianWords(1000)).toBe("One Thousand");
    expect(numberToIndianWords(99999)).toBe("Ninety Nine Thousand Nine Hundred Ninety Nine");
    expect(numberToIndianWords(100000)).toBe("One Lakh");
    expect(numberToIndianWords(1234567)).toBe(
      "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven"
    );
    expect(numberToIndianWords(10000000)).toBe("One Crore");
    expect(numberToIndianWords(123456789)).toBe(
      "Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine"
    );
  });

  it("keeps grouping in crores past a hundred", () => {
    expect(numberToIndianWords(1000000000)).toBe("One Hundred Crore");
  });
});

describe("amountInWords", () => {
  it("reads a whole amount", () => {
    expect(amountInWords(1000)).toBe("Rupees One Thousand Only");
  });

  it("includes paise when there are any", () => {
    expect(amountInWords(1234.56)).toBe(
      "Rupees One Thousand Two Hundred Thirty Four and Fifty Six Paise Only"
    );
  });

  it("omits paise when there are none", () => {
    expect(amountInWords(500.0)).toBe("Rupees Five Hundred Only");
  });

  it("rounds paise rather than truncating", () => {
    // Truncating is how the words end up a paisa adrift from the figures
    // printed beside them on the same document.
    expect(amountInWords(0.005)).toBe("Rupees Zero and One Paise Only");
    expect(amountInWords(99.994)).toBe("Rupees Ninety Nine and Ninety Nine Paise Only");
    expect(amountInWords(99.996)).toBe("Rupees One Hundred Only");
  });

  it("handles zero and negatives", () => {
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(-250.5)).toBe("Minus Rupees Two Hundred Fifty and Fifty Paise Only");
  });
});
