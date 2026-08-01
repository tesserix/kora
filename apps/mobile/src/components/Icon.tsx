import { SymbolView, type SFSymbol } from "expo-symbols";
import { Platform } from "react-native";
import {
  House, BookOpen, Camera, LineChart, Grid2x2, MessageCircle, Mic, Plus,
  Utensils, TrendingDown, TrendingUp, Minus, Check, ArrowRight, ArrowLeft, Trash2,
  Drumstick, Leaf, Wheat, Egg, Fish, Apple, Coffee, Soup, Salad, Circle,
  X, Images, ScanBarcode, Type, Loader, Barcode, ArrowUp, Repeat, Users, Bell,
  Search, Trophy, Heart, Star, Bookmark, Sparkles,
  type LucideIcon,
} from "lucide-react-native";

const SYMBOLS: Record<string, SFSymbol> = {
  house: "house.fill", "book-open": "book.fill", camera: "camera.fill",
  "chart-line": "chart.line.uptrend.xyaxis", "grid-2x2": "square.grid.2x2.fill",
  "message-circle": "message.fill", mic: "mic.fill", plus: "plus",
  utensils: "fork.knife", "trending-down": "arrow.down.right", "trending-up": "arrow.up.right",
  minus: "minus", check: "checkmark", "arrow-right": "arrow.right", "arrow-left": "chevron.left",
  "trash-2": "trash.fill", x: "xmark", images: "photo.on.rectangle",
  "scan-barcode": "barcode.viewfinder", type: "character.cursor.ibeam", barcode: "barcode",
  "arrow-up": "arrow.up", repeat: "arrow.clockwise", users: "person.2.fill", bell: "bell.fill",
  "chevron-right": "chevron.right", droplet: "drop.fill", person: "person.crop.circle.fill",
  gear: "gearshape.fill", flame: "flame.fill", search: "magnifyingglass",
  people: "person.3.fill", trophy: "trophy.fill", heart: "heart.fill",
  "star": "star", "star-fill": "star.fill",
  "bookmark": "bookmark", "bookmark-fill": "bookmark.fill",
  sparkles: "sparkles",
};

const MAP: Record<string, LucideIcon> = {
  house: House, "book-open": BookOpen, camera: Camera, "chart-line": LineChart,
  "grid-2x2": Grid2x2, "message-circle": MessageCircle, mic: Mic,
  plus: Plus, utensils: Utensils, "trending-down": TrendingDown, "trending-up": TrendingUp,
  minus: Minus, check: Check, "arrow-right": ArrowRight, "arrow-left": ArrowLeft, "trash-2": Trash2,
  drumstick: Drumstick, leaf: Leaf, wheat: Wheat, egg: Egg, fish: Fish, apple: Apple,
  coffee: Coffee, soup: Soup, salad: Salad,
  x: X, images: Images, "scan-barcode": ScanBarcode, type: Type, loader: Loader,
  barcode: Barcode, "arrow-up": ArrowUp, repeat: Repeat, users: Users, bell: Bell,
  search: Search, people: Users, trophy: Trophy, heart: Heart,
  "star": Star, "star-fill": Star,
  "bookmark": Bookmark, "bookmark-fill": Bookmark,
  sparkles: Sparkles,
};

type Props = { name: string; size?: number; color: string; strokeWidth?: number };

export function Icon({ name, size = 20, color, strokeWidth = 2 }: Props) {
  const sf = SYMBOLS[name];
  if (sf && Platform.OS === "ios") return <SymbolView name={sf} size={size} tintColor={color} />;
  const Cmp = MAP[name] ?? Circle;
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}
