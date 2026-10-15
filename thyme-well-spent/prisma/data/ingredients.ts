// name|category|baseUnit|gramsPerPiece|kcal|protein|carbs|fat|fiber|priceINRper100
// Nutrition per 100 g (or 100 ml). Values are approximate reference figures.
const RAW = `
onion|Produce|pc|110|40|1.1|9.3|0.1|1.7|4
tomato|Produce|pc|120|18|0.9|3.9|0.2|1.2|5
potato|Produce|pc|150|77|2|17|0.1|2.2|3
spinach|Produce|g|0|23|2.9|3.6|0.4|2.2|6
cauliflower|Produce|g|0|25|1.9|5|0.3|2|4
carrot|Produce|pc|70|41|0.9|9.6|0.2|2.8|5
bell pepper|Produce|pc|150|26|1|6|0.3|2.1|8
cucumber|Produce|pc|200|15|0.7|3.6|0.1|0.5|4
garlic|Produce|pc|4|149|6.4|33|0.5|2.1|10
ginger|Produce|g|0|80|1.8|18|0.8|2|8
green chilli|Produce|pc|8|40|2|9|0.2|1.5|10
coriander leaves|Produce|g|0|23|2.1|3.7|0.5|2.8|10
mint leaves|Produce|g|0|44|3.3|8|0.7|6.8|12
basil|Produce|g|0|23|3.2|2.7|0.6|1.6|20
lemon|Produce|pc|60|29|1.1|9.3|0.3|2.8|8
banana|Produce|pc|118|89|1.1|23|0.3|2.6|6
apple|Produce|pc|180|52|0.3|14|0.2|2.4|18
mixed berries|Produce|g|0|50|0.7|12|0.3|2.4|40
mango|Produce|pc|200|60|0.8|15|0.4|1.6|10
avocado|Produce|pc|150|160|2|9|15|6.7|30
zucchini|Produce|pc|200|17|1.2|3.1|0.3|1|6
broccoli|Produce|g|0|34|2.8|7|0.4|2.6|8
okra|Produce|g|0|33|1.9|7.5|0.2|3.2|7
eggplant|Produce|pc|250|25|1|6|0.2|3|5
green peas|Produce|g|0|81|5.4|14|0.4|5.7|10
cabbage|Produce|g|0|25|1.3|5.8|0.1|2.5|3
mushroom|Produce|g|0|22|3.1|3.3|0.3|1|20
sweet potato|Produce|pc|130|86|1.6|20|0.1|3|5
corn kernels|Produce|g|0|86|3.3|19|1.4|2|8
spring onion|Produce|g|0|32|1.8|7.3|0.2|2.6|8
curry leaves|Produce|g|0|108|6|18.7|1|6.4|20
lettuce|Produce|g|0|15|1.4|2.9|0.2|1.3|6
pumpkin|Produce|g|0|26|1|6.5|0.1|0.5|3
chicken breast|Meat & Seafood|g|0|165|31|0|3.6|0|32
chicken thigh|Meat & Seafood|g|0|209|26|0|10.9|0|25
chicken mince|Meat & Seafood|g|0|143|17|0|8|0|35
mutton|Meat & Seafood|g|0|234|25|0|14|0|75
salmon|Meat & Seafood|g|0|208|20|0|13|0|90
prawns|Meat & Seafood|g|0|99|24|0.2|0.3|0|60
white fish|Meat & Seafood|g|0|90|20|0|1|0|40
canned tuna|Meat & Seafood|g|0|116|26|0|1|0|45
egg|Dairy & Eggs|pc|50|143|12.6|0.7|9.5|0|14
milk|Dairy & Eggs|ml|0|61|3.2|4.8|3.3|0|6
greek yogurt|Dairy & Eggs|g|0|73|10|3.6|1.9|0|20
curd|Dairy & Eggs|g|0|61|3.5|4.7|3.3|0|8
paneer|Dairy & Eggs|g|0|296|18|3.4|22|0|40
cheddar|Dairy & Eggs|g|0|350|24|1.3|27|0|50
mozzarella|Dairy & Eggs|g|0|280|22|2.2|22|0|45
feta|Dairy & Eggs|g|0|264|14|4|21|0|60
parmesan|Dairy & Eggs|g|0|431|38|4|29|0|90
butter|Dairy & Eggs|g|0|717|0.9|0.1|81|0|55
ghee|Dairy & Eggs|g|0|900|0|0|100|0|65
basmati rice|Grains|g|0|360|7|78|0.6|1.3|9
brown rice|Grains|g|0|362|7.5|76|2.7|3.4|9
rolled oats|Grains|g|0|379|13|68|6.5|10|9
poha|Grains|g|0|350|6.6|77|1.2|2|8
rava|Grains|g|0|360|12.7|73|1.1|3.9|6
whole wheat flour|Grains|g|0|340|12|72|1.7|11|5
all-purpose flour|Grains|g|0|364|10|76|1|2.7|5
besan|Grains|g|0|387|22|58|6.7|11|10
rice flour|Grains|g|0|366|6|80|1.4|2.4|7
idli dosa batter|Grains|g|0|120|3|24|0.5|1|10
pasta|Grains|g|0|371|13|75|1.5|3.2|12
whole wheat bread|Grains|pc|35|247|13|41|3.4|7|10
tortilla wrap|Grains|pc|45|300|8|50|7|2.5|12
pita bread|Grains|pc|60|275|9|55|1.2|2.2|10
quinoa|Grains|g|0|368|14|64|6|7|30
couscous|Grains|g|0|376|13|77|0.6|5|15
rice noodles|Grains|g|0|360|6|80|0.6|1|15
soba noodles|Grains|g|0|336|14|74|0.7|3.7|30
sushi rice|Grains|g|0|360|6.7|80|0.6|0.5|12
toor dal|Pantry|g|0|343|22|63|1.5|15|14
moong dal|Pantry|g|0|347|24|63|1.2|16|12
masoor dal|Pantry|g|0|353|25|60|1|11|10
chickpeas|Pantry|g|0|364|19|61|6|17|10
kidney beans|Pantry|g|0|333|24|60|0.8|25|14
black beans|Pantry|g|0|341|21|62|1.4|16|14
tomato puree|Pantry|g|0|38|1.7|8|0.2|1.5|8
coconut milk|Pantry|ml|0|197|2|3|21|0|25
cooking oil|Pantry|ml|0|884|0|0|100|0|15
olive oil|Pantry|ml|0|884|0|0|100|0|80
sesame oil|Pantry|ml|0|884|0|0|100|0|40
peanut butter|Pantry|g|0|588|25|20|50|6|35
almonds|Pantry|g|0|579|21|22|50|12|90
cashews|Pantry|g|0|553|18|30|44|3.3|90
walnuts|Pantry|g|0|654|15|14|65|6.7|110
peanuts|Pantry|g|0|567|26|16|49|8.5|18
chia seeds|Pantry|g|0|486|17|42|31|34|70
honey|Pantry|g|0|304|0.3|82|0|0|35
sugar|Pantry|g|0|387|0|100|0|0|5
tofu|Pantry|g|0|76|8|1.9|4.8|0.3|25
hummus|Pantry|g|0|166|8|14|10|6|40
tahini|Pantry|g|0|595|17|21|54|9|80
vegetable stock|Pantry|ml|0|5|0.1|1|0|0|3
olives|Pantry|g|0|115|0.8|6|11|3.2|40
cocoa powder|Pantry|g|0|228|20|58|14|33|60
desiccated coconut|Pantry|g|0|354|3.3|15|33|9|30
tamarind paste|Pantry|g|0|239|2.8|62|0.6|5|15
protein powder|Pantry|g|0|400|80|8|6|1|150
dates|Pantry|g|0|277|1.8|75|0.2|7|50
nori sheets|Pantry|pc|3|35|5.8|5|0.3|0.3|30
salt|Spices & Condiments|g|0|0|0|0|0|0|1
black pepper|Spices & Condiments|g|0|251|10|64|3.3|25|100
turmeric|Spices & Condiments|g|0|312|9.7|67|3.3|22.7|30
cumin seeds|Spices & Condiments|g|0|375|18|44|22|10|50
coriander powder|Spices & Condiments|g|0|298|12|55|18|42|30
red chilli powder|Spices & Condiments|g|0|282|13|50|14|34|40
garam masala|Spices & Condiments|g|0|379|15|50|15|25|90
mustard seeds|Spices & Condiments|g|0|508|26|28|36|12|30
oregano|Spices & Condiments|g|0|265|9|69|4.3|43|120
chaat masala|Spices & Condiments|g|0|250|8|50|6|20|80
kasuri methi|Spices & Condiments|g|0|323|23|58|6|25|100
cinnamon|Spices & Condiments|g|0|247|4|81|1.2|53|60
sambar powder|Spices & Condiments|g|0|300|12|50|10|25|80
tandoori masala|Spices & Condiments|g|0|290|10|50|8|20|90
taco seasoning|Spices & Condiments|g|0|290|9|55|6|18|100
zaatar|Spices & Condiments|g|0|270|9|50|10|25|150
thai red curry paste|Spices & Condiments|g|0|120|3|15|5|4|60
soy sauce|Spices & Condiments|ml|0|53|8|5|0.6|0.8|15
fish sauce|Spices & Condiments|ml|0|35|5|3.6|0|0|25
rice vinegar|Spices & Condiments|ml|0|18|0|0.4|0|0|10
miso paste|Spices & Condiments|g|0|199|12|26|6|5|50
dijon mustard|Spices & Condiments|g|0|66|4|6|3.3|3|30
salsa|Spices & Condiments|g|0|36|1.5|7|0.2|1.6|20
sriracha|Spices & Condiments|g|0|93|2|19|1|2|30
frozen mixed vegetables|Frozen|g|0|65|3|13|0.3|4|10
frozen edamame|Frozen|g|0|121|12|9|5|5|25
granola|Snacks|g|0|471|10|64|20|7|40
protein bar|Snacks|pc|50|370|30|35|12|6|60
popcorn|Snacks|g|0|387|13|78|4.5|15|30
roasted chana|Snacks|g|0|364|19|61|6|17|20
dark chocolate|Snacks|g|0|546|5|60|31|7|100
rice cakes|Snacks|pc|9|387|8|82|2.8|4|4
`;

export type IngredientSeed = {
  name: string; normalizedName: string; category: string; defaultUnit: string; gramsPerPiece: number | null;
  kcal100: number; protein100: number; carbs100: number; fat100: number; fiber100: number; pricePer100: number;
};

export const INGREDIENTS: IngredientSeed[] = RAW.trim().split("\n").map((line) => {
  const [name, category, unit, gpp, kcal, p, c, f, fib, price] = line.split("|");
  return {
    name: name.replace(/^./, (m) => m.toUpperCase()), normalizedName: name, category, defaultUnit: unit,
    gramsPerPiece: Number(gpp) || null, kcal100: +kcal, protein100: +p, carbs100: +c, fat100: +f, fiber100: +fib, pricePer100: +price,
  };
});

export const FISH = new Set(["salmon", "prawns", "white fish", "canned tuna"]);
export const MEAT = new Set(["chicken breast", "chicken thigh", "chicken mince", "mutton"]);
export const DAIRY = new Set(["milk", "greek yogurt", "curd", "paneer", "cheddar", "mozzarella", "feta", "parmesan", "butter", "ghee", "honey", "protein powder"]);

export const FOODS = `
Banana, medium|1 medium (118 g)|105|1.3|27|0.4|3.1
Apple, medium|1 medium (182 g)|95|0.5|25|0.3|4.4
Orange|1 medium (131 g)|62|1.2|15|0.2|3.1
Boiled egg|1 large (50 g)|78|6.3|0.6|5.3|0
Whole milk|1 cup (240 ml)|149|7.7|11.7|8|0
Greek yogurt, plain|1 cup (170 g)|100|17|6|0.7|0
Cooked white rice|1 cup (158 g)|205|4.3|45|0.4|0.6
Cooked brown rice|1 cup (195 g)|216|5|45|1.8|3.5
Roti / chapati|1 medium (40 g)|120|3.1|18|3.7|2.4
Dal, cooked|1 cup (200 g)|230|18|40|0.8|15.6
Paneer cubes|100 g|296|18|3.4|22|0
Chicken breast, grilled|100 g|165|31|0|3.6|0
Almonds|28 g (about 23)|164|6|6|14|3.5
Peanut butter|1 tbsp (16 g)|94|4|3|8|1
Oatmeal, cooked|1 cup (234 g)|166|5.9|28|3.6|4
Whole wheat bread|1 slice (28 g)|69|3.6|12|0.9|1.9
Avocado|half (100 g)|160|2|9|15|6.7
Samosa|1 piece (60 g)|160|3|17|9|1.5
Idli|1 piece (40 g)|58|2|12|0.4|0.6
Masala dosa|1 piece (150 g)|290|6|42|11|3
Boiled potato|1 medium (150 g)|116|3|27|0.2|3.3
Hummus|2 tbsp (30 g)|50|2.4|4.2|3|1.8
Chocolate, dark|1 square (10 g)|55|0.5|6|3|0.7
Protein bar|1 bar (50 g)|200|20|20|6|3
Latte|1 medium (350 ml)|190|13|19|7|0
Cheese slice|1 slice (20 g)|70|4|0.4|5.7|0
Pasta, cooked|1 cup (140 g)|220|8|43|1.3|2.5
Tuna, canned|1 can (100 g)|116|26|0|1|0
Mixed nuts|28 g|170|5|6|15|2
Orange juice|1 cup (240 ml)|112|1.7|26|0.5|0.5
`.trim().split("\n").map((l) => {
  const [name, serving, calories, protein, carbs, fat, fiber] = l.split("|");
  return { name, serving, calories: +calories, protein: +protein, carbs: +carbs, fat: +fat, fiber: +fiber };
});
