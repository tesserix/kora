import { createContext, useContext, useState, type ReactNode } from "react";
import { SavedMealSheet, type ComposedItem, type Seed } from "./SavedMealSheet";
import type { MemoryMeal, SavedMeal } from "@/api/types";

type Editor = {
  openCreate: (m: MemoryMeal) => void;
  openEdit: (m: SavedMeal) => void;
  openBlank: () => void;
  openCompose: (items: ComposedItem[]) => void;
};

const Ctx = createContext<Editor>({
  openCreate: () => {},
  openEdit: () => {},
  openBlank: () => {},
  openCompose: () => {},
});

export function useSavedMealEditor() {
  return useContext(Ctx);
}

export function SavedMealSheetProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState<Seed | null>(null);
  const openCreate = (m: MemoryMeal) => setSeed({ mode: "create", meal: m });
  const openEdit = (m: SavedMeal) => setSeed({ mode: "edit", meal: m });
  const openBlank = () => setSeed({ mode: "blank" });
  const openCompose = (items: ComposedItem[]) => setSeed({ mode: "compose", items });
  return (
    <Ctx.Provider value={{ openCreate, openEdit, openBlank, openCompose }}>
      {children}
      <SavedMealSheet seed={seed} onClose={() => setSeed(null)} />
    </Ctx.Provider>
  );
}
