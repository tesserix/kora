const HUES = [30, 70, 150, 200, 285, 340];

const KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/chicken|beef|steak|pork|drumstick|meat|lamb|turkey/i, "drumstick"],
  [/salmon|fish|tuna|prawn|shrimp/i, "fish"],
  [/broccoli|salad|spinach|kale|lettuce|greens|veg/i, "leaf"],
  [/rice|bread|oat|pasta|noodle|wheat|grain|cereal|toast/i, "wheat"],
  [/egg|omelet|omelette/i, "egg"],
  [/apple|banana|berry|fruit|orange|mango/i, "apple"],
  [/coffee|latte|espresso|cappuccino|tea/i, "coffee"],
  [/soup|stew|broth|curry/i, "soup"],
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function iconForName(name: string, mealSlot?: string): string {
  for (const [re, icon] of KEYWORDS) if (re.test(name)) return icon;
  if (mealSlot === "breakfast") return "coffee";
  return "utensils";
}

export function foodVisual(name: string, mealSlot?: string): { hue: number; icon: string } {
  return { hue: HUES[hashString(name) % HUES.length], icon: iconForName(name, mealSlot) };
}
