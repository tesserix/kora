// A controllable stand-in for @/auth/session, installed for every test by
// jest.setup.js. Tests start signed in as "test-user"; use setUser to change
// who is signed in without notifying anyone, and emit to deliver an auth
// transition to onAuthChange listeners the way a real sign-in or sign-out
// would. Reset before every test by jest.afterEnv.js.
type Listener = (uid: string | null) => void;

const DEFAULT_USER = "test-user";

const listeners = new Set<Listener>();
const state = { uid: DEFAULT_USER as string | null, token: "test-token" as string | null };

class AuthSessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AuthSessionError";
  }
}

const defaults = {
  authReady: async () => {},
  currentUserId: () => state.uid,
  getAccessToken: async (_force?: boolean) => (state.uid ? state.token : null),
  onAuthChange: (listener: Listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  signIn: async (_options?: { register?: boolean }) => {},
  signOut: async () => {},
  subjectOf: (_jwt: string): string | null => null,
  parseCallbackParams: (_url: string): Record<string, string> => ({}),
  __resetForTests: () => {},
};

export const sessionMock = {
  isAuthConfigured: true,
  AuthSessionError,
  authReady: jest.fn(defaults.authReady),
  currentUserId: jest.fn(defaults.currentUserId),
  getAccessToken: jest.fn(defaults.getAccessToken),
  onAuthChange: jest.fn(defaults.onAuthChange),
  signIn: jest.fn(defaults.signIn),
  signOut: jest.fn(defaults.signOut),
  subjectOf: jest.fn(defaults.subjectOf),
  parseCallbackParams: jest.fn(defaults.parseCallbackParams),
  __resetForTests: jest.fn(defaults.__resetForTests),

  // Test controls.
  setUser(uid: string | null): void {
    state.uid = uid;
  },
  setToken(token: string | null): void {
    state.token = token;
  },
  emit(uid: string | null): void {
    state.uid = uid;
    for (const listener of [...listeners]) listener(uid);
  },
  listenerCount(): number {
    return listeners.size;
  },
  reset(): void {
    listeners.clear();
    state.uid = DEFAULT_USER;
    state.token = "test-token";
    sessionMock.isAuthConfigured = true;
    for (const [name, impl] of Object.entries(defaults)) {
      (sessionMock[name as keyof typeof defaults] as jest.Mock).mockReset().mockImplementation(impl);
    }
  },
};
