import { render } from "@testing-library/react-native";
import { FriendsLeaderboard } from "../FriendsLeaderboard";

const data = {
  me: { streak_days: 5, adherence_days: 4, adherence_window: 7 },
  friends: [
    { id: "a", display_name: "Ada", sharing: true, streak_days: 9, adherence_days: 6 },
    { id: "b", display_name: "Ben", sharing: false },
  ],
};

test("ranks by streak, shows on-target, and groups non-sharing", async () => {
  const { getByText, queryByText, getAllByText } = await render(<FriendsLeaderboard data={data} />);
  expect(getByText("You")).toBeTruthy();
  expect(getByText("Ada")).toBeTruthy();
  // Ada (streak 9) ranks above You (streak 5): rank labels present
  expect(getByText("4/7 on target")).toBeTruthy(); // your adherence
  expect(getByText("6/7 on target")).toBeTruthy(); // Ada's adherence
  // Ben is non-sharing -> under "Not sharing", no on-target line
  expect(getByText("Not sharing")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
});
