import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  activateMentorProjection,
  deactivateMentorProjection,
  loadActiveMentorProjection,
  loadMentorProjection,
  saveMentorProjection,
  type MentorProjection,
} from "../projection";

const projection: MentorProjection = {
  profile: { quiet_start_minute: 1320, quiet_end_minute: 420 },
  commitments: [{
    id: "c1",
    title: "Walk",
    kind: "walking",
    cadence: "fixed",
    weekdays_mask: 127,
    start_minute: 1020,
    interval_minutes: null,
    end_minute: null,
    timezone: "Australia/Melbourne",
    starts_on: "2026-08-22",
    ends_on: null,
    status: "active",
  }],
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

test("mentor projections stay isolated by account and only the activated owner schedules", async () => {
  await saveMentorProjection("user-a", projection);
  await saveMentorProjection("user-b", { profile: { quiet_start_minute: 1260, quiet_end_minute: 480 }, commitments: [] });

  await activateMentorProjection("user-b");

  expect(await loadMentorProjection("user-a")).toEqual(projection);
  expect(await loadActiveMentorProjection()).toEqual({
    profile: { quiet_start_minute: 1260, quiet_end_minute: 480 },
    commitments: [],
  });

  await deactivateMentorProjection();
  expect(await loadActiveMentorProjection()).toBeNull();
});
