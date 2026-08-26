import { act, render, fireEvent, waitFor } from "@testing-library/react-native";
import { Share } from "react-native";
import { File } from "expo-file-system";

import ExportData from "../export-data";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const mockFetchExport = jest.fn();
jest.mock("@/api/hooks", () => ({ fetchDataExport: () => mockFetchExport() }));

// Spied on the imported object rather than jest.mock'd by module path.
// "react-native/Libraries/Share/Share" is NOT what `import { Share } from
// "react-native"` resolves to here, so mocking that path intercepts nothing —
// the real Share runs, throws in the test environment, and every assertion
// about sharing passes or fails for the wrong reason. (The first version of
// this file did exactly that, and its "removes the file even when sharing
// fails" test passed while the file had never been written at all.)
const mockShare = jest.spyOn(Share, "share");

// expo-file-system is NOT mocked here. jest.setup.js already installs an
// in-memory filesystem for it, and jest.afterEnv.js resets that between tests —
// a local mock would shadow both, break the global __reset hook, and stop
// exercising the real File semantics (create() not overwriting, delete()
// throwing when the file is absent) that this screen depends on.

const DOC = {
  format_version: 1,
  exported_at: "2026-08-26T02:00:00Z",
  user_id: "u1",
  redacted: [{ table: "users", column: "apple_refresh_token", reason: "credential" }],
  counts: { food_logs: 2 },
  tables: { food_logs: [{ id: "1" }, { id: "2" }] },
};

const EXPECTED_URI = "file:///cache/kora-export-2026-08-26.json";

// shared captures the file's contents AT SHARE TIME. The screen deletes the
// file immediately afterwards, so reading it from the test body would always
// find it gone — and a test that read it after the fact would be asserting on
// the cleanup rather than on what the user received.
let shared: string | null = null;

// atShare records what the share sheet was actually handed. Without it, a
// cleanup assertion ("the file is gone") passes just as well when the file was
// never written, which is the weaker of the two things it could mean.
function captureShare(): jest.Mock {
  return jest.fn(({ url }: { url: string }) => {
    shared = new File(url).textSync();
    return Promise.resolve({ action: "sharedAction" });
  }) as unknown as jest.Mock;
}

beforeEach(() => {
  shared = null;
  mockFetchExport.mockReset().mockResolvedValue(DOC);
  mockShare.mockReset().mockImplementation(captureShare());
});

test("says what the export contains, in the user's words", async () => {
  const { getByText } = await render(<ExportData />);
  expect(getByText(/every food log/i)).toBeTruthy();
  expect(getByText(/weight, measurements/i)).toBeTruthy();
  expect(getByText(/friends, groups/i)).toBeTruthy();
});

// The screen states what is withheld and why. An export that is quietly
// incomplete is the defect; saying so is what makes it honest.
test("names what is withheld and why", async () => {
  const { getByText } = await render(<ExportData />);
  expect(getByText(/credentials that sign you in/i)).toBeTruthy();
  expect(getByText(/never stores your food photos/i)).toBeTruthy();
});

test("writes the whole document and hands the file to the share sheet", async () => {
  const { getByTestId } = await render(<ExportData />);
  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(mockShare).toHaveBeenCalled());
  expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({ url: EXPECTED_URI }));

  // The ENVELOPE reaches the file, not just the table map. This is the half
  // the client would silently lose if the server keyed its tables "data":
  // apiFetch returns `envelope.data ?? envelope`, so a "data" key would be
  // unwrapped and format_version/exported_at/counts/redacted would vanish
  // with nothing failing.
  expect(shared).not.toBeNull();
  const parsed = JSON.parse(shared as unknown as string);
  expect(parsed.format_version).toBe(1);
  expect(parsed.exported_at).toBe("2026-08-26T02:00:00Z");
  expect(parsed.counts.food_logs).toBe(2);
  expect(parsed.redacted).toHaveLength(1);
  expect(parsed.tables.food_logs).toHaveLength(2);
});

// The filename is dated from the document the SERVER stamped, not from the
// device clock, so the name and the contents can never disagree.
test("names the file after the export's own date", async () => {
  mockFetchExport.mockResolvedValue({ ...DOC, exported_at: "2026-01-02T22:00:00Z" });
  const { getByTestId } = await render(<ExportData />);

  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() =>
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({ url: "file:///cache/kora-export-2026-01-02.json" }),
    ),
  );
});

// The file holds one person's entire health history. Leaving it in the cache
// directory after the sheet closes is a copy nobody accounted for.
test("removes the file after sharing", async () => {
  const { getByTestId } = await render(<ExportData />);
  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(mockShare).toHaveBeenCalled());
  await waitFor(() => expect(new File(EXPECTED_URI).exists).toBe(false));
});

test("removes the file even when sharing fails", async () => {
  // Read the file first, THEN reject — so this proves the file was written and
  // then cleaned up, not merely that it never existed.
  let existedAtShare = false;
  mockShare.mockImplementation((({ url }: { url: string }) => {
    existedAtShare = new File(url).exists;
    return Promise.reject(new Error("user cancelled"));
  }) as unknown as typeof Share.share);

  const { getByTestId, getByText } = await render(<ExportData />);
  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(mockShare).toHaveBeenCalled());
  expect(existedAtShare).toBe(true);
  await waitFor(() => expect(new File(EXPECTED_URI).exists).toBe(false));

  // ...and it is REPORTED. A sharing failure that cleaned up silently would
  // leave the user looking at an idle button, unable to tell whether their
  // export had been produced at all.
  await waitFor(() => expect(getByText(/having trouble right now/i)).toBeTruthy());
});

// A failed export must not reach the share sheet at all — an empty or
// half-written file handed to someone as "your data" is worse than an error.
// The message is apiErrorMessage's copy, not the thrown error's text: this
// screen never renders a raw failure, and asserting on the copy is what pins
// that.
test("reports a failed export instead of sharing an empty file", async () => {
  mockFetchExport.mockRejectedValue(new Error("pq: connection reset by peer"));
  const { getByTestId, getByText } = await render(<ExportData />);

  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(getByText(/having trouble right now/i)).toBeTruthy());
  expect(mockShare).not.toHaveBeenCalled();
  expect(new File(EXPECTED_URI).exists).toBe(false);
});

// The raw throwable can carry a driver string or a host name. It is useful in
// a log and is not something to render at someone.
test("never renders the raw failure", async () => {
  mockFetchExport.mockRejectedValue(new Error("pq: connection reset by peer"));
  const { getByTestId, queryByText } = await render(<ExportData />);

  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(queryByText(/having trouble/i)).toBeTruthy());
  expect(queryByText(/connection reset by peer/i)).toBeNull();
});

// A second press while the first is still in flight would race two writes onto
// one filename. The latch is a ref, not the `pending` state, because two
// presses in the same tick both read the pre-commit state from their render
// closure and both pass.
test("a double press runs the export once", async () => {
  let release: (v: unknown) => void = () => {};
  mockFetchExport.mockReturnValue(
    new Promise((r) => {
      release = r;
    }),
  );

  const { getByTestId } = await render(<ExportData />);
  const button = getByTestId("create-export");

  // Both presses in ONE tick, deliberately NOT awaited between. Awaiting lets
  // `pending` commit, so `disabled` blocks the second press and the ref latch
  // — the only thing standing between two presses dispatched in the same tick
  // — is never exercised. (It was not, in the first version of this test:
  // removing the latch entirely still passed.)
  // Wrapped in one act() so React settles the resulting state updates before
  // the test ends — two bare presses leak updates outside act and corrupt the
  // NEXT test's render. Both are still dispatched before any await, which is
  // what makes this one tick.
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  expect(mockFetchExport).toHaveBeenCalledTimes(1);

  release(DOC);
  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
});

test("the button reports that it is working, then recovers", async () => {
  let release: (v: unknown) => void = () => {};
  mockFetchExport.mockReturnValue(
    new Promise((r) => {
      release = r;
    }),
  );

  const { getByTestId, getByText } = await render(<ExportData />);
  await fireEvent.press(getByTestId("create-export"));

  await waitFor(() => expect(getByText(/preparing/i)).toBeTruthy());

  release(DOC);
  await waitFor(() => expect(getByText(/create my export/i)).toBeTruthy());
});
