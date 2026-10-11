import { Platform } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { apiFetchMultipart } from "@/lib/api";
import LabelScan from "../label-scan";

jest.mock("@/lib/firebase", () => ({ auth: { currentUser: null } }));
jest.mock("expo-image-picker", () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn(), UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" } }));
jest.mock("expo-router", () => ({ router: { back: jest.fn(), replace: jest.fn(), canGoBack: () => true } }));
jest.mock("@/lib/api", () => ({ apiFetchMultipart: jest.fn(), currentUserId: () => "test-user" }));

describe.each(["ios", "android"] as const)("label upload on %s", (platform) => {
const originalPlatform = Platform.OS;
afterAll(() => { Object.defineProperty(Platform, "OS", { value: originalPlatform, configurable: true }); });
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, "OS", { value: platform, configurable: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: "file:///label.jpg", mimeType: "image/jpeg", fileName: "label.jpg" }] });
});

test("upload automatically shows label facts without inventing consumed nutrition", async () => {
  (apiFetchMultipart as jest.Mock).mockResolvedValue({ basis: "per_100g", per_100: { energy_kcal: 200, protein_g: null }, per_serving: {}, needs_review: false, issues: [], analysis: { status: "ready", summary: "The amount eaten is unknown.", escalated: false, consumed_amount_known: false } });
  const view = await render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity }, queries: { gcTime: Infinity } } })}><LabelScan /></QueryClientProvider>);
  await fireEvent.press(view.getByLabelText("Upload label image"));
  await waitFor(() => expect(apiFetchMultipart).toHaveBeenCalledTimes(1));
  expect(await view.findByText("200 kcal")).toBeTruthy();
  expect(view.getByText(/per 100 g/i)).toBeTruthy();
  expect(view.getByText("The amount eaten is unknown.")).toBeTruthy();
  expect(view.queryByText("Add to diary")).toBeNull();
});

test("an unreadable image offers another upload without a manual measurement form", async () => {
  (apiFetchMultipart as jest.Mock).mockRejectedValue(new Error("unreadable"));
  const view = await render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity }, queries: { gcTime: Infinity } } })}><LabelScan /></QueryClientProvider>);
  await fireEvent.press(view.getByLabelText("Upload label image"));
  expect(await view.findByText(/Couldn't read this image/)).toBeTruthy();
  expect(view.getByLabelText("Upload label image")).toBeTruthy();
});


test("denied permission does not upload and offers Settings", async () => {
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const view = await render(<QueryClientProvider client={new QueryClient()}><LabelScan /></QueryClientProvider>);
  await fireEvent.press(view.getByLabelText("Upload label image"));
  expect(await view.findByLabelText("Open photo settings")).toBeTruthy();
  expect(apiFetchMultipart).not.toHaveBeenCalled();
});

test("cancelled image selection does not send an AI request", async () => {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: null });
  const view = await render(<QueryClientProvider client={new QueryClient()}><LabelScan /></QueryClientProvider>);
  await fireEvent.press(view.getByLabelText("Upload label image"));
  await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));
  expect(apiFetchMultipart).not.toHaveBeenCalled();
  expect(view.queryByText(/Couldn't read/)).toBeNull();
});

});
