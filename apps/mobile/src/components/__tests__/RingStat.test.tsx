import { render, fireEvent } from "@testing-library/react-native";
import { RingStat } from "../RingStat";

describe("RingStat", () => {
  it("value state shows the number + meta", async () => {
    const { getByText } = await render(
      <RingStat label="Steps" dotColor="#8FD400" state="value" value="8,240" meta="of 10,000" ringValue={8240} ringMax={10000} />,
    );
    expect(getByText("Steps")).toBeTruthy();
    expect(getByText("8,240")).toBeTruthy();
    expect(getByText("of 10,000")).toBeTruthy();
  });

  it("connect state shows the affordance and NO number", async () => {
    const onConnect = jest.fn();
    const { getByLabelText, queryByText } = await render(
      <RingStat label="Steps" dotColor="#8FD400" state="connect" value="8,240" onConnect={onConnect} />,
    );
    const btn = getByLabelText("Connect Apple Health");
    fireEvent.press(btn);
    expect(onConnect).toHaveBeenCalled();
    // INVARIANT: the passed value must never render in connect state
    expect(queryByText("8,240")).toBeNull();
  });

  it("empty state shows the placeholder, not a fabricated value", async () => {
    const { getByText, queryByText } = await render(
      <RingStat label="Avg intake" dotColor="#34C759" state="empty" value="1,921" />,
    );
    expect(getByText("—")).toBeTruthy();
    expect(queryByText("1,921")).toBeNull();
  });
});
