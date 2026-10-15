import { cn } from "@/lib/utils";

// Original generated artwork: warm gradient + emoji. (Real photography can be supplied via Recipe.image.)
const PALETTES: Record<string, [string, string]> = {
  Indian: ["#F6C177", "#E2724A"], Italian: ["#F3A48B", "#C8553D"], Mexican: ["#F2D06B", "#D9822B"], Mediterranean: ["#A8D5BA", "#4F9A94"],
  Japanese: ["#F5B7C0", "#C56B85"], Thai: ["#C5E1A5", "#6FA35A"], American: ["#F0C987", "#B9774A"], "Middle Eastern": ["#E8C39E", "#B5764D"], Other: ["#D9D2C5", "#9C9486"],
};
const KEYWORDS: [RegExp, string][] = [
  [/dosa|chilla|pancake|paratha|quesadilla|flatbread/, "🥞"], [/idli|upma|poha|oats|porridge|khichdi|kheer|pudding|chia/, "🥣"], [/biryani|pulao|rice|risotto/, "🍚"], [/soup|rasam|minestrone|miso|stew/, "🍲"],
  [/salad|chaat|tabbouleh|caprese|slaw/, "🥗"], [/pasta|spaghetti|mac/, "🍝"], [/taco|fajita/, "🌮"], [/burrito|wrap|shawarma|souvlaki/, "🌯"], [/noodle|pad thai|soba/, "🍜"],
  [/sushi|teriyaki|salmon rice/, "🍣"], [/egg|omelette|bhurji|shakshuka|huevos/, "🍳"], [/smoothie|lassi/, "🥤"], [/avocado|guac|toast|bruschetta/, "🥑"], [/berry|yogurt|bowl/, "🍓"],
  [/chocolate|mousse|bites|balls/, "🍫"], [/apple/, "🍎"], [/mango/, "🥭"], [/curry|masala|dal|sambar|rajma|chole|paneer|tikka|butter/, "🍛"], [/chicken|kofta|kebab/, "🍗"], [/fish|prawn|shrimp|salmon|tuna/, "🐟"],
  [/falafel|hummus/, "🧆"], [/potato|aloo|gobi/, "🥔"], [/pepper/, "🫑"], [/edamame|bean|chili/, "🫘"], [/burger|melt|sandwich/, "🥪"],
];
const CUISINE_EMOJI: Record<string, string> = { Indian: "🍛", Italian: "🍝", Mexican: "🌮", Mediterranean: "🥗", Japanese: "🍱", Thai: "🍜", American: "🍔", "Middle Eastern": "🥙", Other: "🍽️" };

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
export const emojiFor = (title: string, cuisine: string) => KEYWORDS.find(([re]) => re.test(title.toLowerCase()))?.[1] ?? CUISINE_EMOJI[cuisine] ?? "🍽️";

export function FoodArt({ title, cuisine, className, emojiClass }: { title: string; cuisine: string; className?: string; emojiClass?: string }) {
  const [a, b] = PALETTES[cuisine] ?? PALETTES.Other;
  const h = hash(title);
  const angle = 120 + (h % 80);
  return (
    <div aria-hidden className={cn("relative flex items-center justify-center overflow-hidden", className)} style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }}>
      <div className="absolute -left-6 -top-6 h-28 w-28 rounded-full bg-white/20" style={{ transform: `translate(${h % 30}px, ${h % 20}px)` }} />
      <div className="absolute -bottom-10 -right-8 h-36 w-36 rounded-full bg-black/10" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
      <span className={cn("relative select-none drop-shadow-[0_6px_10px_rgba(0,0,0,0.25)]", emojiClass ?? "text-5xl")}>{emojiFor(title, cuisine)}</span>
    </div>
  );
}
