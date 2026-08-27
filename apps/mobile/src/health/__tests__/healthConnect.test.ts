import { readSleepSamples, readSteps, requestPermissions } from "../healthConnect";

const mockGetSdkStatus = jest.fn();
const mockInitialize = jest.fn();
const mockRequestPermission = jest.fn();
const mockReadRecords = jest.fn();
const mockAggregateRecord = jest.fn();

jest.mock("react-native-health-connect", () => ({
  getSdkStatus: (...a: unknown[]) => mockGetSdkStatus(...a),
  initialize: (...a: unknown[]) => mockInitialize(...a),
  requestPermission: (...a: unknown[]) => mockRequestPermission(...a),
  readRecords: (...a: unknown[]) => mockReadRecords(...a),
  aggregateRecord: (...a: unknown[]) => mockAggregateRecord(...a),
  SdkAvailabilityStatus: { SDK_UNAVAILABLE: 1, SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2, SDK_AVAILABLE: 3 },
}));

const iso = (h: number, m = 0) => new Date(Date.UTC(2026, 2, 10, h, m)).toISOString();

beforeEach(() => jest.clearAllMocks());

describe("readSteps", () => {
  // Raw records are per-source, so a phone-plus-watch user double-counts.
  // aggregateRecord applies Health Connect's own de-duplication — the same
  // reason the iOS path uses a statistics query rather than summing samples.
  test("returns the aggregated total", async () => {
    mockAggregateRecord.mockResolvedValue({ COUNT_TOTAL: 8412 });

    await expect(readSteps(new Date(), new Date())).resolves.toBe(8412);
    expect(mockAggregateRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: "Steps" }),
    );
  });

  // null and 0 are different facts: "we could not measure" versus "measured,
  // and you have not moved". Collapsing them shows a confident zero every
  // morning before the user walks.
  test("an absent total is null, never zero", async () => {
    mockAggregateRecord.mockResolvedValue({});

    await expect(readSteps(new Date(), new Date())).resolves.toBeNull();
  });

  test("a thrown native call degrades to null rather than propagating", async () => {
    mockAggregateRecord.mockRejectedValue(new Error("not linked"));

    await expect(readSteps(new Date(), new Date())).resolves.toBeNull();
  });
});

describe("readSleepSamples", () => {
  // AWAKE and OUT_OF_BED are time in a session but not time ASLEEP. Counting
  // them is exactly the gap between Kora's figure and the platform's own.
  test("keeps only asleep stages", async () => {
    mockReadRecords.mockResolvedValue({
      records: [
        {
          startTime: iso(22),
          endTime: iso(6),
          stages: [
            { startTime: iso(22), endTime: iso(23), stage: 4 }, // LIGHT
            { startTime: iso(23), endTime: iso(1), stage: 5 }, // DEEP
            { startTime: iso(1), endTime: iso(2), stage: 1 }, // AWAKE — excluded
            { startTime: iso(2), endTime: iso(3), stage: 6 }, // REM
            { startTime: iso(3), endTime: iso(4), stage: 3 }, // OUT_OF_BED — excluded
          ],
        },
      ],
    });

    const samples = await readSleepSamples(new Date(), new Date());

    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.startDate.toISOString())).toEqual([iso(22), iso(23), iso(2)]);
  });

  // Two nights are in range whenever a lookback spans them. The most recent is
  // the one "last night" means.
  test("uses the most recent session, by end time", async () => {
    mockReadRecords.mockResolvedValue({
      records: [
        { startTime: iso(2), endTime: iso(9), stages: [{ startTime: iso(2), endTime: iso(9), stage: 2 }] },
        { startTime: iso(20), endTime: iso(23), stages: [{ startTime: iso(20), endTime: iso(23), stage: 2 }] },
      ],
    });

    const samples = await readSleepSamples(new Date(), new Date());

    expect(samples).toHaveLength(1);
    expect(samples[0].startDate.toISOString()).toBe(iso(20));
  });

  // Some sources write a session with no stage breakdown. Treating that as
  // zero would erase a night that was genuinely recorded, just less precisely.
  test("falls back to the session span when it carries no stages", async () => {
    mockReadRecords.mockResolvedValue({ records: [{ startTime: iso(23), endTime: iso(23, 30) }] });

    const samples = await readSleepSamples(new Date(), new Date());

    expect(samples).toHaveLength(1);
    expect(samples[0].endDate.toISOString()).toBe(iso(23, 30));
  });

  test("no sessions is an empty list, not a throw", async () => {
    mockReadRecords.mockResolvedValue({ records: [] });

    await expect(readSleepSamples(new Date(), new Date())).resolves.toEqual([]);
  });
});

describe("requestPermissions", () => {
  // Health Connect grants per record type, so a partial grant is possible.
  // Treating it as success leaves a tile permanently empty with nothing
  // explaining why.
  test("a partial grant is not a grant", async () => {
    mockRequestPermission.mockResolvedValue([{ accessType: "read", recordType: "Steps" }]);

    await expect(requestPermissions()).resolves.toBe(false);
  });

  test("both scopes granted is a grant", async () => {
    mockRequestPermission.mockResolvedValue([
      { accessType: "read", recordType: "Steps" },
      { accessType: "read", recordType: "SleepSession" },
    ]);

    await expect(requestPermissions()).resolves.toBe(true);
  });
});
