import { test } from "node:test";
import assert from "node:assert/strict";
import { descriptionKey, findLearnedRule, ruleMatches } from "../../src/utils/descriptionKey.js";
import { suggestIncomeCategory } from "../../src/utils/incomeClassifier.js";
import { suggestCategory } from "../../src/utils/classifier.js";

test("descriptionKey drops digits, dates and punctuation", () => {
  assert.equal(descriptionKey("משכורת 09/26 - חברה בע\"מ"), "משכורת חברה בע מ");
  assert.equal(descriptionKey("  העברה 4471823 מיוסי "), "העברה מיוסי");
  assert.equal(descriptionKey("NETFLIX.COM 12345"), "netflix com");
});

test("a rule learned from one month matches the next month's variant", () => {
  assert.ok(ruleMatches("משכורת 09/26 חברה בע\"מ", "משכורת 10/26 חברה בע\"מ"));
  assert.ok(!ruleMatches("משכורת 09/26 חברה", "שכירות 10/26"));
});

test("a rule with no words keeps the raw substring match", () => {
  assert.ok(ruleMatches("4471823", "העברה 4471823"));
  assert.ok(!ruleMatches("4471823", "העברה 9999"));
  assert.ok(!ruleMatches("  ", "anything"));
});

test("the most specific matching rule wins", () => {
  const rules = [
    { description: "העברה", category: "העברות מלקוחות", subCategory: "העברה בנקאית" },
    { description: "העברה 123 מיוסי", category: "משפחה", subCategory: "יוסי" },
  ];
  assert.equal(findLearnedRule("העברה 456 מיוסי כהן", rules)?.category, "משפחה");
  assert.equal(findLearnedRule("העברה מדני", rules)?.category, "העברות מלקוחות");
});

test("rules without a category are ignored", () => {
  assert.equal(findLearnedRule("משכורת", [{ description: "משכורת", category: "", subCategory: "" }]), undefined);
});

test("both classifiers prefer learned rules over keyword rules", () => {
  const income = [{ description: "משכורת 09/26 אקמה", category: "משכורת", subCategory: "בונוס" }];
  assert.deepEqual(suggestIncomeCategory("משכורת 10/26 אקמה", income), {
    category: "משכורת",
    subCategory: "בונוס",
    source: "learned",
  });
  const expense = [{ description: "הוראת קבע 55 ועד בית", category: "דיור", subCategory: "ועד בית" }];
  assert.equal(suggestCategory("הוראת קבע 56 ועד בית", expense)?.subCategory, "ועד בית");
});
