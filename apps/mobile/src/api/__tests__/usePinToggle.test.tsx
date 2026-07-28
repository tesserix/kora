import { renderHook } from "@testing-library/react-native";

const mockCreateMutate = jest.fn();
const mockDeleteMutate = jest.fn();
let mockPinsData: { food_item_id: string }[] = [];

jest.mock("../hooks", () => ({
  usePins: () => ({ data: mockPinsData }),
  useCreatePin: () => ({ mutate: mockCreateMutate }),
  useDeletePin: () => ({ mutate: mockDeleteMutate }),
}));

import { usePinToggle } from "../usePinToggle";

beforeEach(() => {
  mockCreateMutate.mockReset();
  mockDeleteMutate.mockReset();
  mockPinsData = [];
});

test("toggle pins an un-pinned food (create with portion)", async () => {
  const { result } = await renderHook(() => usePinToggle());
  result.current.toggle({ food_item_id: "f1", name: "Egg", meal_slot: "breakfast", grams: 100 });
  expect(mockCreateMutate).toHaveBeenCalledWith({ food_item_id: "f1", grams: 100, meal_slot: "breakfast" });
  expect(mockDeleteMutate).not.toHaveBeenCalled();
});

test("toggle unpins an already-pinned food (delete by id)", async () => {
  mockPinsData = [{ food_item_id: "f1" }];
  const { result } = await renderHook(() => usePinToggle());
  expect(result.current.pinnedIds.has("f1")).toBe(true);
  result.current.toggle({ food_item_id: "f1", name: "Egg", meal_slot: "breakfast", grams: 100 });
  expect(mockDeleteMutate).toHaveBeenCalledWith("f1");
  expect(mockCreateMutate).not.toHaveBeenCalled();
});
