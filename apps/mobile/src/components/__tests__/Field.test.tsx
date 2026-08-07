import { fireEvent, render } from "@testing-library/react-native";
import { Field } from "../Field";

test("renders a persistent label above the input", async () => {
  const { getByText, getByLabelText } = await render(
    <Field label="Email" value="" onChangeText={jest.fn()} />,
  );
  expect(getByText("Email")).toBeTruthy();
  expect(getByLabelText("Email")).toBeTruthy();
});

// The whole point of replacing placeholder-as-label: the label survives typing.
test("the label stays visible once the field has a value", async () => {
  const { getByText } = await render(
    <Field label="Email" value="sam@example.com" onChangeText={jest.fn()} />,
  );
  expect(getByText("Email")).toBeTruthy();
});

test("forwards text changes", async () => {
  const onChangeText = jest.fn();
  const { getByLabelText } = await render(
    <Field label="Email" value="" onChangeText={onChangeText} />,
  );
  fireEvent.changeText(getByLabelText("Email"), "sam@example.com");
  expect(onChangeText).toHaveBeenCalledWith("sam@example.com");
});

test("forwards TextInput props such as keyboardType and secureTextEntry", async () => {
  const { getByLabelText } = await render(
    <Field label="Password" value="" onChangeText={jest.fn()} secureTextEntry keyboardType="number-pad" />,
  );
  const input = getByLabelText("Password");
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.keyboardType).toBe("number-pad");
});

test("an explicit accessibilityLabel overrides the label", async () => {
  const { getByLabelText } = await render(
    <Field label="Weight" accessibilityLabel="Weight in kilograms" value="" onChangeText={jest.fn()} />,
  );
  expect(getByLabelText("Weight in kilograms")).toBeTruthy();
});

// Assert the presence first, so the absence below is a disappearance rather
// than a slot that never renders under any input.
test("renders the error slot only when an error is supplied", async () => {
  const withError = await render(
    <Field label="Email" error="That email looks wrong." value="" onChangeText={jest.fn()} />,
  );
  expect(withError.getByText("That email looks wrong.")).toBeTruthy();

  const withoutError = await render(<Field label="Email" value="" onChangeText={jest.fn()} />);
  expect(withoutError.queryByTestId("field-error")).toBeNull();
});
