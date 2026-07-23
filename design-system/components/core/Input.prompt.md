Text field with a 2px border and a soft 4px focus ring. Pass `isValid`/`isInvalid` for validity affordances and `helperText`/`errorText` for messages.

```jsx
<Input placeholder="you@email.com" />
<Input isInvalid errorText="Enter a valid email" defaultValue="nope" />
<Input isValid helperText="Looks good" />
```
