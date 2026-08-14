import { renderHook } from "@testing-library/react-native";

import { usePinToggle } from "../usePinToggle";

const mockCreateMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockShow = jest.fn();
let mockPinsData: { food_item_id: string }[] = [];

jest.mock("../hooks", () => ({
  usePins: () => ({ data: mockPinsData }),
  useCreatePin: () => ({ mutate: mockCreateMutate }),
  useDeletePin: () => ({ mutate: mockDeleteMutate }),
}));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));

beforeEach(() => {
  mockCreateMutate.mockReset();
  mockDeleteMutate.mockReset();
  mockShow.mockReset();
  mockPinsData = [];
});

const FOOD = { food_item_id: "f1", name: "Egg", meal_slot: "breakfast" as const, grams: 100 };

test("toggle pins an un-pinned food (create with portion)", async () => {
  const { result } = await renderHook(() => usePinToggle());
  result.current.toggle(FOOD);
  expect(mockCreateMutate).toHaveBeenCalledWith(
    { food_item_id: "f1", grams: 100, meal_slot: "breakfast" },
    expect.objectContaining({ onError: expect.any(Function) }),
  );
  expect(mockDeleteMutate).not.toHaveBeenCalled();
});

test("toggle unpins an already-pinned food (delete by id)", async () => {
  mockPinsData = [{ food_item_id: "f1" }];
  const { result } = await renderHook(() => usePinToggle());
  expect(result.current.pinnedIds.has("f1")).toBe(true);
  result.current.toggle(FOOD);
  expect(mockDeleteMutate).toHaveBeenCalledWith(
    "f1",
    expect.objectContaining({ onError: expect.any(Function) }),
  );
  expect(mockCreateMutate).not.toHaveBeenCalled();
});

// #83: without these the star silently fails to change state — the user taps,
// the pin does not stick, and nothing says why.
test("a failed pin surfaces the offline message", async () => {
  const { result } = await renderHook(() => usePinToggle());
  result.current.toggle(FOOD);
  const onError = mockCreateMutate.mock.calls[0][1].onError;
  onError(Object.assign(new Error("down"), { name: "NetworkError" }));
  expect(mockShow).toHaveBeenCalledWith({ message: "Couldn't reach Kora. Check your connection." });
});

test("a failed unpin surfaces the server message", async () => {
  mockPinsData = [{ food_item_id: "f1" }];
  const { result } = await renderHook(() => usePinToggle());
  result.current.toggle(FOOD);
  const onError = mockDeleteMutate.mock.calls[0][1].onError;
  onError(Object.assign(new Error("boom"), { name: "ApiError", status: 500 }));
  expect(mockShow).toHaveBeenCalledWith({
    message: "Kora is having trouble right now. Please try again in a moment.",
  });
});
