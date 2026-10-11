import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { AddFriendSheet } from "../AddFriendSheet";
import { ApiError } from "@/lib/api";

const noop = () => {};

// The real "@/lib/api" pulls in firebase/auth (real ESM), which Jest cannot
// parse unmocked — every other test that reaches @/lib/api (directly or via
// a component under test) mocks it for exactly this reason. Only ApiError is
// needed here: AddFriendSheet's error handling narrows on it to tell a 404
// miss apart from a 429 rate limit.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId?: string;
    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.name = "ApiError";
    }
  },
}));

const mockSendRequest = jest.fn();
const mockLookup = jest.fn();
jest.mock("@/api/hooks", () => ({
  useSendFriendRequest: () => ({ mutate: mockSendRequest, isPending: false }),
  useLookupHandle: () => ({ mutate: mockLookup, isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
}));
beforeEach(() => {
  mockSendRequest.mockClear();
  mockLookup.mockClear();
});

// A pasted friend code (e.g. from a mobile://friend/<code> link in a message
// thread) is not a handle. It 404s the lookup exactly like a stranger's typo
// would, and — because it has the 8-char Crockford shape a real handle never
// collides with — that 404 is retried as a code send instead of shown as an
// error, so codes already in circulation keep resolving now that handle
// lookup is the primary path (kora#449).
test("a pasted friend code 404s the lookup, then sends as a code", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onError?.(new ApiError(404, "not_found", "No Kora account has that handle.")),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "XYZ789AB");
  await fireEvent.press(getByText("Find"));
  expect(mockLookup).toHaveBeenCalledWith("XYZ789AB", expect.anything());
  expect(mockSendRequest).toHaveBeenCalledWith(
    { code: "XYZ789AB" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("an input containing @ is sent as email", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "pal@kora.app");
  await fireEvent.press(getByText("Find"));
  expect(mockSendRequest).toHaveBeenCalledWith(
    { email: "pal@kora.app" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("shows my share code", async () => {
  const { getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  expect(getByText("ABC123XY")).toBeTruthy();
});

test("surfaces the backend error message on a failed request", async () => {
  mockSendRequest.mockImplementation((_input, opts) => opts.onError?.(new Error("you can't add yourself")));
  const { getByLabelText, getByText, findByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "me@kora.app");
  await fireEvent.press(getByText("Find"));
  expect(await findByText("you can't add yourself")).toBeTruthy();
});

it("looks up a handle and shows the person before anything is sent", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onSuccess?.({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" }),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));

  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());
  expect(getByText("@ada")).toBeTruthy();
  expect(mockSendRequest).not.toHaveBeenCalled();
});

// The defect this prevents: a card rendering a previous result, or a
// half-populated one, while a request is still in flight — a factual claim
// about who someone is, made from state that is not an answer yet.
it("shows no person while the lookup is pending", async () => {
  let resolve: (v: unknown) => void = () => {};
  mockLookup.mockImplementation(
    (_handle, opts) =>
      new Promise((r) => {
        resolve = (v) => {
          opts.onSuccess?.(v);
          r(v);
        };
      }),
  );
  const { getByLabelText, getByText, queryByText } = await render(<AddFriendSheet visible onClose={noop} />);

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));

  expect(queryByText("Send request")).toBeNull();
  expect(getByText("Looking up…")).toBeTruthy();

  await act(async () => {
    resolve({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" });
  });
  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());
});

// Editing the field after a resolved result must drop the card immediately,
// before any new submit — otherwise typing a correction leaves the PREVIOUS
// person's name on screen next to text that no longer describes them, the
// same factual-claim-from-stale-state failure as the pending case above, just
// reached by editing instead of by re-submitting.
it("drops the card the moment the field is edited, before any new submit", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onSuccess?.({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" }),
  );
  const { getByLabelText, getByText, queryByText } = await render(<AddFriendSheet visible onClose={noop} />);

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "adamant");
  expect(queryByText("Ada L")).toBeNull();
  expect(queryByText("Send request")).toBeNull();
});

// A miss and a success must not read alike. This is the 404-vs-200-with-empty
// failure from kora#443, in a new place.
it("says nobody has that handle on a miss, and offers nothing to send", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onError?.(new ApiError(404, "not_found", "No Kora account has that handle.")),
  );
  const { getByLabelText, getByText, queryByText } = await render(<AddFriendSheet visible onClose={noop} />);

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "nobody");
  await fireEvent.press(getByText("Find"));

  await waitFor(() => expect(getByText("No Kora account has that handle.")).toBeTruthy());
  expect(queryByText("Send request")).toBeNull();
});

it("tells the user plainly when they are looking up too fast", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onError?.(new ApiError(429, "rate_limited", "Too many lookups. Try again in a minute.")),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("Too many lookups. Try again in a minute.")).toBeTruthy());
});

// An email or a friend code must still work — every existing invite link is a
// friend code, and they cannot stop resolving because handles arrived.
it("still sends by email without a lookup", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "someone@example.test");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(mockSendRequest).toHaveBeenCalledWith({ email: "someone@example.test" }, expect.anything()));
  expect(mockLookup).not.toHaveBeenCalled();
});

// A blank display_name above "send them a request" is the kora#443 defect
// verbatim: a sentence about a person, with no person named.
it("falls back to the handle when the display name is blank", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onSuccess?.({ id: "u1", display_name: "", handle: "ada", avatar_url: "" }),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("@ada")).toBeTruthy());
});

// This is the defect that actually shipped: the card's "Send request" must
// put the resolved person's HANDLE on the wire, not their friend code (there
// isn't one to put there) and not the code field, which the server resolves
// against friend_code, never handle_canonical (api/internal/user/repository.go's
// FindByCode) — a handle sent as `code` 404s a real backend even though the
// card is showing the right person (kora#449 task 13b).
it("sends the resolved person's handle, not a code, when Send request is pressed", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onSuccess?.({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" }),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);

  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());

  await fireEvent.press(getByText("Send request"));
  expect(mockSendRequest).toHaveBeenCalledWith(
    { handle: "ada" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(mockSendRequest).not.toHaveBeenCalledWith(
    { code: "ada" },
    expect.anything(),
  );
});

// A leading @ is how people write a handle, and stripping it BEFORE the email
// test is what stops "@ada" being routed as an email.
it("routes a handle typed with a leading @ to lookup, not email", async () => {
  mockLookup.mockImplementation((_handle, opts) =>
    opts.onSuccess?.({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" }),
  );
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={noop} />);
  await fireEvent.changeText(getByLabelText("Handle, email or friend code"), "@ada");
  await fireEvent.press(getByText("Find"));
  await waitFor(() => expect(mockLookup).toHaveBeenCalledWith("ada", expect.anything()));
  expect(mockSendRequest).not.toHaveBeenCalled();
});
