import {
  House, BookOpen, Camera, LineChart, Grid2x2, Sparkles, MessageCircle, Mic, Plus,
  Utensils, TrendingDown, TrendingUp, Minus, Check, ArrowRight, ArrowLeft, Trash2,
  Drumstick, Leaf, Wheat, Egg, Fish, Apple, Coffee, Soup, Salad, Circle,
  X, Images, ScanBarcode, Type, Loader, Barcode, ArrowUp,
  type LucideIcon,
} from "lucide-react-native";

const MAP: Record<string, LucideIcon> = {
  house: House, "book-open": BookOpen, camera: Camera, "chart-line": LineChart,
  "grid-2x2": Grid2x2, sparkles: Sparkles, "message-circle": MessageCircle, mic: Mic,
  plus: Plus, utensils: Utensils, "trending-down": TrendingDown, "trending-up": TrendingUp,
  minus: Minus, check: Check, "arrow-right": ArrowRight, "arrow-left": ArrowLeft, "trash-2": Trash2,
  drumstick: Drumstick, leaf: Leaf, wheat: Wheat, egg: Egg, fish: Fish, apple: Apple,
  coffee: Coffee, soup: Soup, salad: Salad,
  x: X, images: Images, "scan-barcode": ScanBarcode, type: Type, loader: Loader,
  barcode: Barcode, "arrow-up": ArrowUp,
};

type Props = { name: string; size?: number; color: string; strokeWidth?: number };

export function Icon({ name, size = 20, color, strokeWidth = 2 }: Props) {
  const Cmp = MAP[name] ?? Circle;
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}
