/* @ds-bundle: {"format":4,"namespace":"TesserixDesignSystem_275930","components":[{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"CardHeader","sourcePath":"components/core/Card.jsx"},{"name":"CardTitle","sourcePath":"components/core/Card.jsx"},{"name":"CardDescription","sourcePath":"components/core/Card.jsx"},{"name":"CardContent","sourcePath":"components/core/Card.jsx"},{"name":"CardFooter","sourcePath":"components/core/Card.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Separator","sourcePath":"components/core/Separator.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Callout","sourcePath":"components/feedback/Callout.jsx"},{"name":"CircularProgress","sourcePath":"components/feedback/CircularProgress.jsx"},{"name":"Progress","sourcePath":"components/feedback/Progress.jsx"},{"name":"Skeleton","sourcePath":"components/feedback/Skeleton.jsx"},{"name":"Stat","sourcePath":"components/feedback/Stat.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"}],"sourceHashes":{"components/core/Avatar.jsx":"547d41b96d47","components/core/Badge.jsx":"1f399c60d00d","components/core/Button.jsx":"5571879dc940","components/core/Card.jsx":"d6ae1dc996a6","components/core/Icon.jsx":"bb3bea649a87","components/core/Input.jsx":"740598aeda87","components/core/Separator.jsx":"91acf1861469","components/core/Tag.jsx":"7f1fb22e4dc7","components/feedback/Callout.jsx":"75bb07e09954","components/feedback/CircularProgress.jsx":"aaa7d1b1932f","components/feedback/Progress.jsx":"1fdc144a544a","components/feedback/Skeleton.jsx":"f94b76781fac","components/feedback/Stat.jsx":"97140c769950","components/forms/Checkbox.jsx":"ae7a65ac36c9","components/forms/Switch.jsx":"70855574af95","ui_kits/kora/AddonsScreen.jsx":"17e054168ffb","ui_kits/kora/CaptureScreen.jsx":"8875224e7c9c","ui_kits/kora/Chrome.jsx":"81c3fdc86412","ui_kits/kora/CoachScreen.jsx":"e5bbd9412d5a","ui_kits/kora/DiaryScreen.jsx":"2ef62a296ba8","ui_kits/kora/HomeScreen.jsx":"fe006f57cca9","ui_kits/kora/InsightsScreen.jsx":"bfdb60faad97","ui_kits/kora/KoraApp.jsx":"db6d6d49e65c","ui_kits/kora/MealDetail.jsx":"09899ced21d9","ui_kits/kora/Onboarding.jsx":"31a1072bdea9","ui_kits/kora/PlannerScreen.jsx":"e5abc1a95bed","ui_kits/kora/ProgressScreen.jsx":"9fba72bc9847","ui_kits/kora/RestaurantScreen.jsx":"3f674f371b57"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.TesserixDesignSystem_275930 = window.TesserixDesignSystem_275930 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Avatar — circular image with initials fallback. sm32 md40 lg48 xl64. */
const SIZES = {
  sm: 32,
  md: 40,
  lg: 48,
  xl: 64
};
function Avatar({
  src,
  alt = "",
  initials,
  size = "md",
  style,
  ...props
}) {
  const px = typeof size === "number" ? size : SIZES[size] || 40;
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: px,
      height: px,
      borderRadius: "var(--radius-full)",
      overflow: "hidden",
      background: "var(--muted)",
      color: "var(--muted-foreground)",
      flexShrink: 0,
      fontFamily: "var(--font-sans)",
      fontWeight: "var(--font-semibold)",
      fontSize: px * 0.4,
      border: "1px solid var(--border)",
      ...style
    }
  }, props), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt,
    style: {
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  }) : (initials || "").slice(0, 2).toUpperCase());
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Badge — pill, rounded-full, px-2.5 py-0.5, text-xs semibold.
 *  Variants map to the semantic status tokens (badge.tsx). */
const VARIANTS = {
  default: {
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow-sm)"
  },
  secondary: {
    background: "var(--secondary)",
    color: "var(--secondary-foreground)",
    border: "1px solid transparent"
  },
  destructive: {
    background: "var(--destructive)",
    color: "var(--destructive-foreground)",
    border: "1px solid transparent"
  },
  outline: {
    background: "transparent",
    color: "var(--foreground)",
    border: "1px solid var(--border)"
  },
  success: {
    background: "var(--success-muted)",
    color: "var(--success-muted-foreground)",
    border: "1px solid transparent"
  },
  warning: {
    background: "var(--warning-muted)",
    color: "var(--warning-muted-foreground)",
    border: "1px solid transparent"
  },
  error: {
    background: "var(--error-muted)",
    color: "var(--error-muted-foreground)",
    border: "1px solid transparent"
  },
  info: {
    background: "var(--info-muted)",
    color: "var(--info-muted-foreground)",
    border: "1px solid transparent"
  },
  neutral: {
    background: "var(--neutral-muted)",
    color: "var(--neutral-muted-foreground)",
    border: "1px solid transparent"
  }
};
function Badge({
  variant = "default",
  style,
  children,
  ...props
}) {
  const v = VARIANTS[variant] || VARIANTS.default;
  return /*#__PURE__*/React.createElement("span", _extends({
    "data-slot": "badge",
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      width: "fit-content",
      flexShrink: 0,
      whiteSpace: "nowrap",
      borderRadius: "var(--radius-full)",
      padding: "2px 10px",
      fontFamily: "var(--font-sans)",
      fontSize: "var(--text-xs)",
      fontWeight: "var(--font-semibold)",
      lineHeight: 1.35,
      ...v,
      ...style
    }
  }, props), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Button — cva-derived variants translated to the token system.
 *  Exact geometry from button.tsx: h-10 default, rounded-lg, text-sm, gap-2. */
const VARIANTS = {
  default: {
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow)"
  },
  destructive: {
    background: "var(--destructive)",
    color: "var(--destructive-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow-sm)"
  },
  outline: {
    background: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--input)",
    boxShadow: "var(--shadow-sm)"
  },
  secondary: {
    background: "var(--secondary)",
    color: "var(--secondary-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow-sm)"
  },
  ghost: {
    background: "transparent",
    color: "var(--foreground)",
    border: "1px solid transparent"
  },
  link: {
    background: "transparent",
    color: "var(--primary)",
    border: "1px solid transparent",
    textDecoration: "underline",
    textUnderlineOffset: "4px"
  },
  success: {
    background: "var(--success)",
    color: "var(--success-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow-sm)"
  },
  warning: {
    background: "var(--warning)",
    color: "var(--warning-foreground)",
    border: "1px solid transparent",
    boxShadow: "var(--shadow-sm)"
  }
};
const SIZES = {
  default: {
    height: 40,
    padding: "0 16px",
    fontSize: "var(--text-sm)",
    borderRadius: "var(--radius-lg)"
  },
  sm: {
    height: 36,
    padding: "0 12px",
    fontSize: "var(--text-xs)",
    borderRadius: "var(--radius-md)"
  },
  lg: {
    height: 48,
    padding: "0 32px",
    fontSize: "var(--text-base)",
    borderRadius: "var(--radius-lg)"
  },
  xl: {
    height: 56,
    padding: "0 40px",
    fontSize: "var(--text-lg)",
    borderRadius: "var(--radius-lg)"
  },
  icon: {
    height: 40,
    width: 40,
    padding: 0,
    borderRadius: "var(--radius-lg)"
  },
  "icon-sm": {
    height: 32,
    width: 32,
    padding: 0,
    borderRadius: "var(--radius-md)"
  },
  "icon-lg": {
    height: 44,
    width: 44,
    padding: 0,
    borderRadius: "var(--radius-lg)"
  }
};
function Button({
  variant = "default",
  size = "default",
  isLoading = false,
  loadingText,
  disabled = false,
  style,
  children,
  ...props
}) {
  const v = VARIANTS[variant] || VARIANTS.default;
  const s = SIZES[size] || SIZES.default;
  const isDisabled = disabled || isLoading;
  return /*#__PURE__*/React.createElement("button", _extends({
    disabled: isDisabled,
    "aria-busy": isLoading || undefined,
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      whiteSpace: "nowrap",
      fontFamily: "var(--font-sans)",
      fontWeight: "var(--font-medium)",
      lineHeight: 1,
      cursor: isDisabled ? "not-allowed" : "pointer",
      opacity: isDisabled ? 0.5 : 1,
      transition: "var(--transition-colors), box-shadow var(--duration-normal) var(--ease-in-out)",
      outline: "none",
      ...v,
      ...s,
      ...style
    }
  }, props), isLoading ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    style: {
      animation: "tsx-spin 0.8s linear infinite"
    },
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10",
    stroke: "currentColor",
    strokeWidth: "4",
    opacity: "0.25"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "currentColor",
    opacity: "0.75",
    d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
  })), /*#__PURE__*/React.createElement("span", null, loadingText || "Loading…")) : children, /*#__PURE__*/React.createElement("style", null, "@keyframes tsx-spin{to{transform:rotate(360deg)}}"));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Card — rounded-xl, border, bg-card. `glass` variant uses backdrop-blur.
 *  Exact from card.tsx (shadow-lg → hover shadow-xl). */
function Card({
  variant = "default",
  style,
  children,
  ...props
}) {
  const base = {
    borderRadius: "var(--radius-xl)",
    color: "var(--card-foreground)",
    transition: "var(--transition-all)",
    fontFamily: "var(--font-sans)"
  };
  const v = variant === "glass" ? {
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(255,255,255,0.1)",
    boxShadow: "var(--shadow-xl)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)"
  } : {
    border: "1px solid var(--border)",
    background: "var(--card)",
    boxShadow: "var(--shadow-lg)"
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    "data-slot": "card",
    style: {
      ...base,
      ...v,
      ...style
    }
  }, props), children);
}
function CardHeader({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    "data-slot": "card-header",
    style: {
      display: "grid",
      gap: 8,
      padding: 24,
      ...style
    }
  }, props), children);
}
function CardTitle({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("h3", _extends({
    "data-slot": "card-title",
    style: {
      margin: 0,
      fontSize: "var(--text-2xl)",
      fontWeight: "var(--font-bold)",
      lineHeight: "var(--leading-tight)",
      letterSpacing: "var(--tracking-tight)",
      ...style
    }
  }, props), children);
}
function CardDescription({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    "data-slot": "card-description",
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--muted-foreground)",
      ...style
    }
  }, props), children);
}
function CardContent({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    "data-slot": "card-content",
    style: {
      padding: "0 24px 24px",
      ...style
    }
  }, props), children);
}
function CardFooter({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    "data-slot": "card-footer",
    style: {
      display: "flex",
      alignItems: "center",
      padding: "0 24px 24px",
      ...style
    }
  }, props), children);
}
Object.assign(__ds_scope, { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Icon — renders a Lucide glyph from the global `lucide` UMD build
 *  (window.lucide). Load once via:
 *    <script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
 *  Builds inner SVG markup from the lucide IconNode array with strict guards so an
 *  unknown/misparsed icon degrades to an empty <svg> instead of throwing.
 *  Sizes match iconSizes (xs12 sm16 md20 lg24 xl32 2xl40); stroke 2 by default. */
const SIZES = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
  "2xl": 40
};
function pascal(name) {
  return String(name).replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}
function getNode(name) {
  const g = typeof window !== "undefined" ? window.lucide : null;
  if (!g) return null;
  const p = pascal(name);
  const candidates = [g.icons && g.icons[p], g.icons && g.icons[name], g[p]];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}
function nodeToInner(node) {
  if (!Array.isArray(node)) return "";
  // lucide IconNode shape: [tag, attrs, childrenArray]; real elements are at index [2].
  const children = Array.isArray(node[2]) ? node[2] : node;
  let out = "";
  for (const entry of children) {
    if (!Array.isArray(entry)) continue;
    const tag = entry[0];
    const attrs = entry[1] || {};
    if (typeof tag !== "string") continue;
    let a = "";
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || typeof v === "object") continue;
      a += ` ${k}="${String(v).replace(/"/g, "&quot;")}"`;
    }
    out += `<${tag}${a} />`;
  }
  return out;
}
function Icon({
  name,
  size = "md",
  color = "currentColor",
  strokeWidth = 2,
  style,
  ...props
}) {
  const px = typeof size === "number" ? size : SIZES[size] || 20;
  const inner = nodeToInner(getNode(name));
  return /*#__PURE__*/React.createElement("svg", _extends({
    xmlns: "http://www.w3.org/2000/svg",
    width: px,
    height: px,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      display: "inline-block",
      flexShrink: 0,
      verticalAlign: "middle",
      ...style
    },
    "aria-hidden": "true",
    dangerouslySetInnerHTML: {
      __html: inner
    }
  }, props));
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Input — h-11, rounded-lg, border-2, px-4, focus ring 4px/20%.
 *  Exact from input.tsx (validity states + helper/error text). */
function Input({
  isValid,
  isInvalid,
  helperText,
  errorText,
  style,
  id,
  ...props
}) {
  const [focused, setFocused] = React.useState(false);
  const autoId = React.useId();
  const inputId = id || autoId;
  const showError = isInvalid && errorText;
  const showHelper = helperText && !showError;
  let borderColor = "var(--input)";
  let ring = "transparent";
  if (isValid) {
    borderColor = "oklch(0.63 0.16 150)";
  }
  if (isInvalid) {
    borderColor = "var(--destructive)";
  }
  if (focused) {
    borderColor = isInvalid ? "var(--destructive)" : isValid ? "oklch(0.63 0.16 150)" : "var(--ring)";
    ring = isInvalid ? "oklch(0.58 0.2157 27.72 / 0.2)" : isValid ? "oklch(0.63 0.16 150 / 0.2)" : "color-mix(in oklch, var(--ring) 20%, transparent)";
  }
  const input = /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    "aria-invalid": isInvalid || undefined,
    onFocus: e => {
      setFocused(true);
      props.onFocus?.(e);
    },
    onBlur: e => {
      setFocused(false);
      props.onBlur?.(e);
    },
    style: {
      height: 44,
      width: "100%",
      boxSizing: "border-box",
      borderRadius: "var(--radius-lg)",
      border: `2px solid ${borderColor}`,
      background: "var(--background)",
      color: "var(--foreground)",
      padding: isValid || isInvalid ? "10px 40px 10px 16px" : "10px 16px",
      fontSize: "var(--text-sm)",
      fontFamily: "var(--font-sans)",
      boxShadow: `var(--shadow-sm), 0 0 0 4px ${ring}`,
      outline: "none",
      transition: "var(--transition-all)"
    }
  }, props));
  if (!isValid && !isInvalid && !helperText && !errorText) return input;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, input, isValid && !isInvalid && /*#__PURE__*/React.createElement("svg", {
    style: {
      position: "absolute",
      right: 12,
      top: "50%",
      transform: "translateY(-50%)",
      pointerEvents: "none"
    },
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "oklch(0.55 0.15 150)",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })), isInvalid && /*#__PURE__*/React.createElement("svg", {
    style: {
      position: "absolute",
      right: 12,
      top: "50%",
      transform: "translateY(-50%)",
      pointerEvents: "none"
    },
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--destructive)",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "12",
    x2: "12",
    y1: "8",
    y2: "12"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "12",
    x2: "12.01",
    y1: "16",
    y2: "16"
  }))), showError && /*#__PURE__*/React.createElement("p", {
    role: "alert",
    style: {
      margin: "6px 0 0",
      fontSize: "var(--text-xs)",
      color: "var(--destructive)"
    }
  }, errorText), showHelper && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "6px 0 0",
      fontSize: "var(--text-xs)",
      color: "var(--muted-foreground)"
    }
  }, helperText));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/Separator.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Separator — hairline divider on --border. */
function Separator({
  orientation = "horizontal",
  style,
  ...props
}) {
  const isV = orientation === "vertical";
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "separator",
    "aria-orientation": orientation,
    style: {
      background: "var(--border)",
      flexShrink: 0,
      width: isV ? 1 : "100%",
      height: isV ? "100%" : 1,
      ...style
    }
  }, props));
}
Object.assign(__ds_scope, { Separator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Separator.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Tag — rounded chip, optional removable & leading dot. Lighter than Badge, for filters/inputs. */
function Tag({
  children,
  onRemove,
  color,
  style,
  ...props
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      borderRadius: "var(--radius-md)",
      padding: "4px 10px",
      background: "var(--secondary)",
      color: "var(--secondary-foreground)",
      border: "1px solid var(--border)",
      fontFamily: "var(--font-sans)",
      fontSize: "var(--text-xs)",
      fontWeight: "var(--font-medium)",
      ...style
    }
  }, props), color && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: "var(--radius-full)",
      background: color
    }
  }), children, onRemove && /*#__PURE__*/React.createElement("button", {
    onClick: onRemove,
    "aria-label": "Remove",
    style: {
      display: "inline-flex",
      border: "none",
      background: "none",
      padding: 0,
      marginLeft: 2,
      cursor: "pointer",
      color: "inherit",
      opacity: 0.6
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }))));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Callout.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Callout — inline message block. Variants map to status muted tokens (callout.tsx / alert.tsx). */
const VARIANTS = {
  info: {
    bg: "var(--info-muted)",
    fg: "var(--info-muted-foreground)",
    bd: "color-mix(in oklch, var(--info) 30%, transparent)"
  },
  success: {
    bg: "var(--success-muted)",
    fg: "var(--success-muted-foreground)",
    bd: "color-mix(in oklch, var(--success) 30%, transparent)"
  },
  warning: {
    bg: "var(--warning-muted)",
    fg: "var(--warning-muted-foreground)",
    bd: "color-mix(in oklch, var(--warning) 30%, transparent)"
  },
  error: {
    bg: "var(--error-muted)",
    fg: "var(--error-muted-foreground)",
    bd: "color-mix(in oklch, var(--error) 30%, transparent)"
  },
  neutral: {
    bg: "var(--neutral-muted)",
    fg: "var(--neutral-muted-foreground)",
    bd: "var(--border)"
  }
};
function Callout({
  variant = "info",
  title,
  icon,
  style,
  children,
  ...props
}) {
  const v = VARIANTS[variant] || VARIANTS.info;
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "note",
    style: {
      display: "flex",
      gap: 12,
      padding: 16,
      borderRadius: "var(--radius-lg)",
      background: v.bg,
      color: v.fg,
      border: `1px solid ${v.bd}`,
      fontFamily: "var(--font-sans)",
      ...style
    }
  }, props), icon && /*#__PURE__*/React.createElement("span", {
    style: {
      flexShrink: 0,
      marginTop: 1
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 2
    }
  }, title && /*#__PURE__*/React.createElement("strong", {
    style: {
      fontSize: "var(--text-sm)",
      fontWeight: "var(--font-semibold)"
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      lineHeight: "var(--leading-normal)",
      opacity: 0.92
    }
  }, children)));
}
Object.assign(__ds_scope, { Callout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Callout.jsx", error: String((e && e.message) || e) }); }

// components/feedback/CircularProgress.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix CircularProgress — ring gauge. Used for calorie/macro rings in the Kora app.
 *  Renders center content (children) e.g. a value + label. */
function CircularProgress({
  value = 0,
  max = 100,
  size = 96,
  stroke = 10,
  color = "var(--primary)",
  track = "var(--secondary)",
  children,
  style,
  ...props
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: "relative",
      width: size,
      height: size,
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    style: {
      transform: "rotate(-90deg)"
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: track,
    strokeWidth: stroke
  }), /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: color,
    strokeWidth: stroke,
    strokeLinecap: "round",
    strokeDasharray: c,
    strokeDashoffset: c * (1 - pct),
    style: {
      transition: "stroke-dashoffset var(--duration-slower) var(--ease-out)"
    }
  })), children != null && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center"
    }
  }, children));
}
Object.assign(__ds_scope, { CircularProgress });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/CircularProgress.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Progress.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Progress — linear bar. Track --secondary, fill --primary (or `color` override). */
function Progress({
  value = 0,
  max = 100,
  color = "var(--primary)",
  height = 8,
  style,
  ...props
}) {
  const pct = Math.max(0, Math.min(100, value / max * 100));
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "progressbar",
    "aria-valuenow": value,
    "aria-valuemin": 0,
    "aria-valuemax": max,
    style: {
      width: "100%",
      height,
      borderRadius: "var(--radius-full)",
      background: "var(--secondary)",
      overflow: "hidden",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${pct}%`,
      height: "100%",
      background: color,
      borderRadius: "var(--radius-full)",
      transition: "width var(--duration-slow) var(--ease-out)"
    }
  }));
}
Object.assign(__ds_scope, { Progress });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Progress.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Skeleton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Skeleton — shimmer placeholder on --muted. */
function Skeleton({
  width = "100%",
  height = 16,
  radius = "var(--radius-md)",
  style,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      width,
      height,
      borderRadius: radius,
      background: "var(--muted)",
      position: "relative",
      overflow: "hidden",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "linear-gradient(90deg, transparent, color-mix(in oklch, var(--background) 55%, transparent), transparent)",
      animation: "tsx-shimmer 1.4s infinite"
    }
  }), /*#__PURE__*/React.createElement("style", null, "@keyframes tsx-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}"));
}
Object.assign(__ds_scope, { Skeleton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Skeleton.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Stat.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Stat — label + big value + optional delta/trend. For dashboards. */
function Stat({
  label,
  value,
  unit,
  delta,
  trend,
  style,
  ...props
}) {
  const up = trend === "up";
  const color = trend ? up ? "var(--success-muted-foreground)" : "var(--error-muted-foreground)" : "var(--muted-foreground)";
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4,
      fontFamily: "var(--font-sans)",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color: "var(--muted-foreground)",
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      fontWeight: "var(--font-medium)"
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-3xl)",
      fontWeight: "var(--font-bold)",
      letterSpacing: "var(--tracking-tight)",
      color: "var(--foreground)"
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, unit)), delta != null && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color,
      fontWeight: "var(--font-medium)",
      display: "inline-flex",
      alignItems: "center",
      gap: 3
    }
  }, trend && /*#__PURE__*/React.createElement("span", null, up ? "▲" : "▼"), delta));
}
Object.assign(__ds_scope, { Stat });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Stat.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Checkbox — 18px box, rounded-sm, fills --primary + check when on. */
function Checkbox({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  style,
  ...props
}) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const on = checked ?? internal;
  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!on);
    onCheckedChange?.(!on);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    role: "checkbox",
    "aria-checked": on,
    disabled: disabled,
    onClick: toggle,
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 18,
      height: 18,
      borderRadius: "var(--radius-sm)",
      border: on ? "1px solid var(--primary)" : "1.5px solid var(--input)",
      background: on ? "var(--primary)" : "var(--background)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      padding: 0,
      flexShrink: 0,
      transition: "var(--transition-colors)",
      ...style
    }
  }, props), on && /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--primary-foreground)",
    strokeWidth: "3",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tesserix Switch — track toggles to --primary when checked; 44x24 thumb. Controlled or uncontrolled. */
function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  style,
  ...props
}) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const on = checked ?? internal;
  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!on);
    onCheckedChange?.(!on);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    role: "switch",
    "aria-checked": on,
    disabled: disabled,
    onClick: toggle,
    style: {
      position: "relative",
      width: 44,
      height: 24,
      borderRadius: "var(--radius-full)",
      border: "none",
      background: on ? "var(--primary)" : "var(--input)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "background var(--duration-normal) var(--ease-in-out)",
      padding: 0,
      flexShrink: 0,
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: on ? 22 : 2,
      width: 20,
      height: 20,
      borderRadius: "var(--radius-full)",
      background: "var(--background)",
      boxShadow: "var(--shadow-sm)",
      transition: "left var(--duration-normal) var(--ease-in-out)"
    }
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/AddonsScreen.jsx
try { (() => {
/* Kora — Add-ons hub. Modular health trackers: steps, water, weight, meds, sleep, fasting. */
const DS = window.TesserixDesignSystem_275930;
function AddonCard({
  icon,
  hue,
  title,
  value,
  unit,
  sub,
  progress,
  children
}) {
  const color = `oklch(0.6 0.15 ${hue})`;
  return /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 36,
      height: 36,
      borderRadius: "var(--radius-lg)",
      background: `oklch(0.94 0.05 ${hue})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: icon,
    size: 19,
    color: color
  })), children), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      fontFamily: "var(--font-mono)",
      letterSpacing: "-0.02em"
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)"
    }
  }, unit)), progress != null && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(DS.Progress, {
    value: progress,
    color: color,
    height: 5
  })), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      marginTop: 6
    }
  }, sub)));
}
function AddonsScreen({
  onNav
}) {
  const {
    ScreenHeader
  } = window;
  const [meds, setMeds] = React.useState(true);
  const TOOLS = [{
    id: "coach",
    icon: "message-circle",
    label: "AI Coach",
    hue: 285
  }, {
    id: "planner",
    icon: "calendar-check",
    label: "Meal plan",
    hue: 45
  }, {
    id: "restaurant",
    icon: "store",
    label: "Restaurants",
    hue: 30
  }, {
    id: "insights",
    icon: "chart-line",
    label: "Insights",
    hue: 220
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 0 118px"
    }
  }, /*#__PURE__*/React.createElement(ScreenHeader, {
    overline: "Health",
    title: "More"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px 18px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr 1fr",
      gap: 10
    }
  }, TOOLS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => onNav(t.id),
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 7,
      padding: "14px 4px",
      borderRadius: "var(--radius-xl)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      boxShadow: "var(--shadow-sm)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40,
      height: 40,
      borderRadius: "var(--radius-lg)",
      background: `oklch(0.95 0.045 ${t.hue})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: t.icon,
    size: 19,
    color: `oklch(0.52 0.13 ${t.hue})`
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: "var(--foreground)",
      textAlign: "center"
    }
  }, t.label))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px 8px",
      fontSize: 13,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)"
    }
  }, "Trackers"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px",
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(AddonCard, {
    icon: "footprints",
    hue: 240,
    title: "Steps",
    value: "8,240",
    sub: "Goal 10,000",
    progress: 82
  }), /*#__PURE__*/React.createElement(AddonCard, {
    icon: "droplet",
    hue: 220,
    title: "Water",
    value: "1.4",
    unit: "/ 2.5 L",
    progress: 56
  }), /*#__PURE__*/React.createElement(AddonCard, {
    icon: "scale",
    hue: 155,
    title: "Weight",
    value: "72.4",
    unit: "kg",
    sub: "\u25BC 0.6 kg this week"
  }), /*#__PURE__*/React.createElement(AddonCard, {
    icon: "moon",
    hue: 280,
    title: "Sleep",
    value: "7.1",
    unit: "hrs",
    sub: "Bed 11:20 \xB7 Wake 6:30"
  }), /*#__PURE__*/React.createElement(AddonCard, {
    icon: "pill",
    hue: 30,
    title: "Medication",
    value: "2 / 3",
    sub: "Vitamin D at 8pm",
    children: /*#__PURE__*/React.createElement(DS.Switch, {
      checked: meds,
      onCheckedChange: setMeds
    })
  }), /*#__PURE__*/React.createElement(AddonCard, {
    icon: "timer",
    hue: 340,
    title: "Fasting",
    value: "14:22",
    sub: "16:8 window",
    progress: 78
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 20px 0"
    }
  }, /*#__PURE__*/React.createElement(DS.Callout, {
    variant: "info",
    title: "Sync health data",
    icon: /*#__PURE__*/React.createElement(DS.Icon, {
      name: "heart-pulse",
      size: 18,
      color: "var(--info-muted-foreground)"
    })
  }, "Connect Apple Health or Google Fit to pull steps, heart rate, and sleep automatically.")));
}
window.AddonsScreen = AddonsScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/AddonsScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/CaptureScreen.jsx
try { (() => {
/* Kora — AI Capture. Unified photo + chat composer with Otto. Futuristic dark surface. */
const DS = window.TesserixDesignSystem_275930;
const DETECTED = [{
  name: "Grilled chicken breast",
  grams: 140,
  kcal: 231,
  hue: 30,
  icon: "drumstick",
  conf: 0.96
}, {
  name: "Steamed broccoli",
  grams: 90,
  kcal: 31,
  hue: 150,
  icon: "leaf",
  conf: 0.91
}, {
  name: "Brown rice",
  grams: 120,
  kcal: 148,
  hue: 70,
  icon: "wheat",
  conf: 0.88
}];
function OttoBubble({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 30,
      height: 30,
      flexShrink: 0,
      borderRadius: "var(--radius-full)",
      background: "var(--primary)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 0 0 3px color-mix(in oklch,var(--primary) 22%,transparent)"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 16,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(255,255,255,0.08)",
      border: "1px solid rgba(255,255,255,0.12)",
      color: "#fff",
      borderRadius: "var(--radius-xl)",
      borderTopLeftRadius: 6,
      padding: "12px 14px",
      fontSize: 14,
      lineHeight: 1.5,
      maxWidth: "80%",
      backdropFilter: "blur(8px)"
    }
  }, children));
}
function UserBubble({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      borderRadius: "var(--radius-xl)",
      borderTopRightRadius: 6,
      padding: "10px 14px",
      fontSize: 14,
      lineHeight: 1.5,
      maxWidth: "80%",
      fontWeight: 500
    }
  }, children));
}
function DetectedCard({
  items,
  onAdd
}) {
  const total = items.reduce((s, i) => s + i.kcal, 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "var(--radius-xl)",
      padding: 14,
      backdropFilter: "blur(8px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.07em",
      color: "rgba(255,255,255,0.6)"
    }
  }, "Detected \xB7 3 items"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 14,
      fontWeight: 700,
      color: "#fff"
    }
  }, total, " kcal")), items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 11,
      padding: "8px 0",
      borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.1)" : "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 38,
      height: 38,
      borderRadius: "var(--radius-md)",
      background: `oklch(0.4 0.1 ${it.hue})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: it.icon,
    size: 18,
    color: `oklch(0.9 0.08 ${it.hue})`
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "#fff"
    }
  }, it.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "rgba(255,255,255,0.55)",
      fontFamily: "var(--font-mono)"
    }
  }, it.grams, "g \xB7 ", Math.round(it.conf * 100), "% match")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      fontWeight: 700,
      color: "#fff"
    }
  }, it.kcal))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(DS.Button, {
    onClick: onAdd,
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "check",
    size: 16,
    color: "var(--primary-foreground)"
  }), "Add to diary"), /*#__PURE__*/React.createElement(DS.Button, {
    variant: "outline",
    style: {
      background: "transparent",
      color: "#fff",
      borderColor: "rgba(255,255,255,0.25)"
    }
  }, "Edit")));
}
function CaptureScreen({
  mode,
  onNav,
  onLog,
  initialStage
}) {
  const [stage, setStage] = React.useState(initialStage || "idle"); // idle → analyzing → result
  const [input, setInput] = React.useState(mode === "chat" ? "type" : "photo");
  const [text, setText] = React.useState("");
  const analyze = () => {
    setStage("analyzing");
    setTimeout(() => setStage("result"), 1400);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "oklch(0.19 0.03 165)",
      display: "flex",
      flexDirection: "column"
    }
  }, window.StatusBar ? /*#__PURE__*/React.createElement(window.StatusBar, {
    dark: true
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      height: 54
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 18px 10px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("home"),
    style: {
      background: "rgba(255,255,255,0.1)",
      border: "none",
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "x",
    size: 20,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      color: "#fff",
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 17,
    color: "var(--primary)"
  }), " Ask Otto"), /*#__PURE__*/React.createElement("button", {
    style: {
      background: "rgba(255,255,255,0.1)",
      border: "none",
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "images",
    size: 18,
    color: "#fff"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "8px 18px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(OttoBubble, null, "Hi Alex \u2014 show me your meal or just tell me what you ate. A photo works great. \uD83D\uDCF7 is optional; words work too."), stage === "idle" && input === "photo" && /*#__PURE__*/React.createElement("div", {
    onClick: analyze,
    style: {
      marginTop: 4,
      position: "relative",
      height: 200,
      borderRadius: "var(--radius-2xl)",
      overflow: "hidden",
      background: "oklch(0.93 0.03 285)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "utensils",
    size: 54,
    color: "oklch(0.52 0.13 285)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      border: "2px dashed rgba(0,0,0,0.12)",
      borderRadius: "var(--radius-2xl)",
      margin: 10
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 12,
      left: 0,
      right: 0,
      textAlign: "center",
      color: "oklch(0.4 0.13 285)",
      fontSize: 13,
      fontWeight: 600
    }
  }, "Tap the viewfinder to capture")), stage === "idle" && input === "voice" && /*#__PURE__*/React.createElement("div", {
    onClick: analyze,
    style: {
      marginTop: 4,
      height: 200,
      borderRadius: "var(--radius-2xl)",
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.12)",
      cursor: "pointer",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 72,
      height: 72,
      borderRadius: "var(--radius-full)",
      background: "var(--primary)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 0 0 10px color-mix(in oklch, var(--primary) 22%, transparent)"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "mic",
    size: 30,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      height: 26
    }
  }, [10, 20, 14, 26, 16, 22, 12, 18, 10].map((h, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: 3,
      height: h,
      borderRadius: 3,
      background: "var(--primary)",
      animation: `tsx-wave 1s ease-in-out ${i * 0.09}s infinite alternate`
    }
  }))), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "rgba(255,255,255,0.75)",
      fontSize: 13,
      fontWeight: 600
    }
  }, "Listening\u2026 tell Otto what you ate"), /*#__PURE__*/React.createElement("style", null, "@keyframes tsx-wave{to{transform:scaleY(1.9)}}")), stage === "idle" && input === "scan" && /*#__PURE__*/React.createElement("div", {
    onClick: analyze,
    style: {
      marginTop: 4,
      position: "relative",
      height: 200,
      borderRadius: "var(--radius-2xl)",
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.12)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 200,
      height: 110,
      borderRadius: "var(--radius-lg)",
      border: "2px solid rgba(255,255,255,0.25)",
      position: "relative",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 0,
      right: 0,
      top: "50%",
      height: 2,
      background: "var(--primary)",
      boxShadow: "0 0 12px var(--primary)",
      animation: "tsx-scan 1.6s ease-in-out infinite alternate"
    }
  }), /*#__PURE__*/React.createElement(DS.Icon, {
    name: "barcode",
    size: 64,
    color: "rgba(255,255,255,0.4)",
    style: {
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%,-50%)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 12,
      left: 0,
      right: 0,
      textAlign: "center",
      color: "rgba(255,255,255,0.7)",
      fontSize: 13,
      fontWeight: 600
    }
  }, "Point at a barcode"), /*#__PURE__*/React.createElement("style", null, "@keyframes tsx-scan{from{top:20%}to{top:80%}}")), stage === "idle" && input === "type" && /*#__PURE__*/React.createElement(UserBubble, null, "Grilled chicken with broccoli and brown rice"), stage === "analyzing" && /*#__PURE__*/React.createElement(React.Fragment, null, mode !== "chat" && /*#__PURE__*/React.createElement(UserBubble, null, "\uD83D\uDCF7 Meal photo"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      color: "rgba(255,255,255,0.7)",
      fontSize: 13,
      paddingLeft: 40
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "loader",
    size: 16,
    color: "var(--primary)",
    style: {
      animation: "tsx-spin 0.9s linear infinite"
    }
  }), "Otto is analyzing\u2026", /*#__PURE__*/React.createElement("style", null, "@keyframes tsx-spin{to{transform:rotate(360deg)}}"))), stage === "result" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(OttoBubble, null, "Got it \u2014 I found three items, about ", /*#__PURE__*/React.createElement("strong", null, "410 kcal"), ". Looks like a lean, high-protein plate. Confirm and I'll log it to dinner."), /*#__PURE__*/React.createElement(DetectedCard, {
    items: DETECTED,
    onAdd: () => {
      onLog(DETECTED);
      onNav("home");
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 14px",
      paddingBottom: 26,
      background: "rgba(0,0,0,0.25)",
      borderTop: "1px solid rgba(255,255,255,0.1)",
      backdropFilter: "blur(12px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, [["camera", "Photo", "photo"], ["mic", "Voice", "voice"], ["scan-barcode", "Scan", "scan"], ["type", "Type", "type"]].map(([ic, l, key]) => {
    const on = input === key;
    return /*#__PURE__*/React.createElement("button", {
      key: l,
      onClick: () => {
        setInput(key);
        setStage("idle");
      },
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: "var(--radius-full)",
        border: "none",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        background: on ? "var(--primary)" : "rgba(255,255,255,0.1)",
        color: on ? "var(--primary-foreground)" : "rgba(255,255,255,0.75)"
      }
    }, /*#__PURE__*/React.createElement(DS.Icon, {
      name: ic,
      size: 14,
      color: on ? "var(--primary-foreground)" : "rgba(255,255,255,0.75)"
    }), l);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      background: "rgba(255,255,255,0.1)",
      borderRadius: "var(--radius-full)",
      padding: "6px 6px 6px 8px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: analyze,
    style: {
      width: 38,
      height: 38,
      borderRadius: "var(--radius-full)",
      background: "var(--primary)",
      border: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "camera",
    size: 19,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("input", {
    value: text,
    onChange: e => setText(e.target.value),
    placeholder: "Tell Otto what you ate\u2026",
    style: {
      flex: 1,
      background: "none",
      border: "none",
      outline: "none",
      color: "#fff",
      fontSize: 15,
      fontFamily: "var(--font-sans)"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: analyze,
    style: {
      width: 38,
      height: 38,
      borderRadius: "var(--radius-full)",
      background: text ? "var(--primary)" : "rgba(255,255,255,0.15)",
      border: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-up",
    size: 19,
    color: "#fff"
  })))));
}
window.CaptureScreen = CaptureScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/CaptureScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/Chrome.jsx
try { (() => {
/* Kora — shared app chrome: phone frame, status bar, bottom tab bar, bottom sheet.
   Consumes the Tesserix bundle via window.TesserixDesignSystem_275930. */
const DS = window.TesserixDesignSystem_275930;
const {
  Icon
} = DS;
function StatusBar({
  dark
}) {
  const c = dark ? "#fff" : "var(--foreground)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 54,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "space-between",
      padding: "0 28px 8px",
      fontFamily: "var(--font-sans)",
      color: c,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      fontFamily: "var(--font-mono)"
    }
  }, "9:41"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 7,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "signal",
    size: 16,
    color: c
  }), /*#__PURE__*/React.createElement(Icon, {
    name: "wifi",
    size: 16,
    color: c
  }), /*#__PURE__*/React.createElement(Icon, {
    name: "battery-full",
    size: 18,
    color: c
  })));
}
const TABS = [{
  id: "home",
  icon: "house",
  label: "Home"
}, {
  id: "diary",
  icon: "book-open",
  label: "Diary"
}, {
  id: "capture",
  icon: "camera",
  label: ""
}, {
  id: "progress",
  icon: "chart-line",
  label: "Progress"
}, {
  id: "addons",
  icon: "grid-2x2",
  label: "More"
}];
function TabBar({
  active,
  onNav
}) {
  const glass = "color-mix(in oklch, var(--card) 68%, transparent)";
  const item = t => {
    if (t.id === "capture") {
      return /*#__PURE__*/React.createElement("button", {
        key: t.id,
        onClick: () => onNav("capture"),
        "aria-label": "Capture",
        style: {
          width: 52,
          height: 52,
          margin: "0 2px",
          borderRadius: "var(--radius-full)",
          border: "none",
          background: "var(--primary)",
          color: "var(--primary-foreground)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 6px 16px -4px color-mix(in oklch, var(--primary) 60%, transparent)",
          cursor: "pointer"
        }
      }, /*#__PURE__*/React.createElement(Icon, {
        name: "sparkles",
        size: 24,
        color: "var(--primary-foreground)"
      }));
    }
    const on = active === t.id;
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      onClick: () => onNav(t.id),
      "aria-label": t.label || t.id,
      style: {
        width: 52,
        height: 52,
        borderRadius: "var(--radius-full)",
        border: "none",
        background: on ? "color-mix(in oklch, var(--primary) 15%, transparent)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: t.icon,
      size: 22,
      color: on ? "var(--primary)" : "var(--muted-foreground)",
      strokeWidth: on ? 2.5 : 2
    }));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      display: "flex",
      justifyContent: "center",
      paddingBottom: 22,
      pointerEvents: "none",
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      pointerEvents: "auto",
      display: "flex",
      alignItems: "center",
      gap: 2,
      padding: 7,
      borderRadius: "var(--radius-full)",
      background: glass,
      backdropFilter: "blur(24px) saturate(180%)",
      WebkitBackdropFilter: "blur(24px) saturate(180%)",
      border: "1px solid color-mix(in oklch, var(--foreground) 9%, transparent)",
      boxShadow: "0 12px 34px -10px rgba(0,0,0,0.28), inset 0 1px 0 color-mix(in oklch, var(--card) 90%, transparent)"
    }
  }, TABS.map(item)));
}

/* Rounded meal/photo tile — soft single-hue tint + centered icon (placeholder for real photography). */
function FoodTile({
  hue = 150,
  icon = "utensils",
  size = 56,
  radius = "var(--radius-lg)"
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      borderRadius: radius,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: `oklch(0.93 0.06 ${hue})`,
      color: `oklch(0.5 0.12 ${hue})`
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: Math.round(size * 0.42),
    color: `oklch(0.5 0.12 ${hue})`
  }));
}

/* Bottom sheet overlay */
function Sheet({
  open,
  onClose,
  children,
  dark
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "absolute",
      inset: 0,
      zIndex: 40,
      display: "flex",
      alignItems: "flex-end",
      background: "rgba(10,20,15,0.38)",
      backdropFilter: "blur(2px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: "100%",
      maxHeight: "82%",
      overflowY: "auto",
      background: dark ? "var(--card)" : "var(--background)",
      borderTopLeftRadius: "var(--radius-2xl)",
      borderTopRightRadius: "var(--radius-2xl)",
      boxShadow: "var(--shadow-2xl)",
      animation: "sheetUp 280ms cubic-bezier(0.4,0,0.2,1)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      paddingTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 5,
      borderRadius: 999,
      background: "var(--border)"
    }
  })), children), /*#__PURE__*/React.createElement("style", null, "@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}"));
}

/* Screen header with title + optional right slot */
function ScreenHeader({
  overline,
  title,
  right
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      padding: "4px 20px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", null, overline && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)",
      marginBottom: 3
    }
  }, overline), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontSize: 28,
      fontWeight: 800,
      letterSpacing: "-0.03em",
      color: "var(--foreground)"
    }
  }, title)), right);
}
Object.assign(window, {
  StatusBar,
  TabBar,
  FoodTile,
  Sheet,
  ScreenHeader
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/Chrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/CoachScreen.jsx
try { (() => {
/* Kora — AI Coach. Otto acts as a supportive nutrition coach: focus cards + conversational thread. */
const DS = window.TesserixDesignSystem_275930;
const FOCUS = [{
  icon: "beef",
  hue: 155,
  title: "Protein",
  body: "142 / 160g — one more Greek yogurt closes the gap.",
  variant: "info"
}, {
  icon: "wheat",
  hue: 70,
  title: "Fibre is low",
  body: "Under target 4 days running. Add beans or berries today.",
  variant: "warning"
}, {
  icon: "trending-down",
  hue: 285,
  title: "Weight trend",
  body: "Down 1.8kg this month — on pace for 75kg in ~6 weeks.",
  variant: "success"
}];
const THREAD = [{
  from: "otto",
  text: "Morning, Alex. You're trending well — protein's been consistent all week. Nice work. 👏"
}, {
  from: "user",
  text: "What should I have for dinner?"
}, {
  from: "otto",
  text: "You've got ~750 kcal and 35g protein left. A salmon fillet with quinoa and greens fits perfectly and pushes your omega-3s up. Want me to add it to your plan?"
}];
const CHIPS = ["Am I on track today?", "More protein ideas", "Plan my dinner", "How's my week?"];
function Bubble({
  from,
  children
}) {
  const otto = from === "otto";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: otto ? "flex-start" : "flex-end",
      gap: 10
    }
  }, otto && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      flexShrink: 0,
      borderRadius: "var(--radius-full)",
      background: "var(--primary)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 15,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "78%",
      background: otto ? "var(--secondary)" : "var(--primary)",
      color: otto ? "var(--foreground)" : "var(--primary-foreground)",
      borderRadius: "var(--radius-xl)",
      borderTopLeftRadius: otto ? 6 : "var(--radius-xl)",
      borderTopRightRadius: otto ? "var(--radius-xl)" : 6,
      padding: "11px 14px",
      fontSize: 14,
      lineHeight: 1.5,
      fontWeight: otto ? 400 : 500
    }
  }, children));
}
function CoachScreen({
  onNav
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background)"
    }
  }, /*#__PURE__*/React.createElement(window.StatusBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 18px 12px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("home"),
    style: {
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-left",
    size: 19,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)"
    }
  }, "Your coach"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      letterSpacing: "-0.03em"
    }
  }, "Otto")), /*#__PURE__*/React.createElement(DS.Badge, {
    variant: "success"
  }, "Evidence-based")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "4px 18px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)",
      margin: "6px 0 10px"
    }
  }, "Today's focus"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10,
      marginBottom: 20
    }
  }, FOCUS.map((f, i) => /*#__PURE__*/React.createElement(DS.Callout, {
    key: i,
    variant: f.variant,
    title: f.title,
    icon: /*#__PURE__*/React.createElement("span", {
      style: {
        width: 30,
        height: 30,
        borderRadius: "var(--radius-lg)",
        background: `oklch(0.94 0.05 ${f.hue})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement(DS.Icon, {
      name: f.icon,
      size: 16,
      color: `oklch(0.5 0.13 ${f.hue})`
    }))
  }, f.body))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, THREAD.map((m, i) => /*#__PURE__*/React.createElement(Bubble, {
    key: i,
    from: m.from
  }, m.text))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 18
    }
  }, CHIPS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--foreground)",
      borderRadius: "var(--radius-full)",
      padding: "8px 14px",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      fontFamily: "var(--font-sans)"
    }
  }, c)))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 16px 28px",
      borderTop: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      background: "var(--secondary)",
      borderRadius: "var(--radius-full)",
      padding: "6px 6px 6px 16px"
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Ask Otto anything\u2026",
    style: {
      flex: 1,
      background: "none",
      border: "none",
      outline: "none",
      fontSize: 15,
      color: "var(--foreground)",
      fontFamily: "var(--font-sans)"
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 38,
      height: 38,
      borderRadius: "var(--radius-full)",
      background: "var(--primary)",
      border: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-up",
    size: 19,
    color: "var(--primary-foreground)"
  })))));
}
window.CoachScreen = CoachScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/CoachScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/DiaryScreen.jsx
try { (() => {
/* Kora — Diary. Week strip + timeline of logged meals for the selected day. */
const DS = window.TesserixDesignSystem_275930;
const WEEK = [{
  d: "M",
  n: 18,
  kcal: 1980
}, {
  d: "T",
  n: 19,
  kcal: 2110
}, {
  d: "W",
  n: 20,
  kcal: 1740
}, {
  d: "T",
  n: 21,
  kcal: 2040
}, {
  d: "F",
  n: 22,
  kcal: 1890
}, {
  d: "S",
  n: 23,
  kcal: 1252,
  today: true
}, {
  d: "S",
  n: 24,
  kcal: null
}];
function DiaryScreen({
  data,
  onOpenMeal
}) {
  const {
    FoodTile,
    ScreenHeader
  } = window;
  const [sel, setSel] = React.useState(23);
  const logged = data.meals.filter(m => m.kcal);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 0 110px"
    }
  }, /*#__PURE__*/React.createElement(ScreenHeader, {
    overline: "This week",
    title: "Diary"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      padding: "0 20px 8px",
      overflowX: "auto"
    }
  }, WEEK.map(w => {
    const on = w.n === sel;
    return /*#__PURE__*/React.createElement("button", {
      key: w.n,
      onClick: () => setSel(w.n),
      style: {
        flex: "1 0 auto",
        minWidth: 42,
        borderRadius: "var(--radius-lg)",
        border: on ? "none" : "1px solid var(--border)",
        background: on ? "var(--primary)" : "var(--card)",
        color: on ? "var(--primary-foreground)" : "var(--foreground)",
        padding: "10px 0",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 600,
        opacity: 0.7
      }
    }, w.d), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 16,
        fontWeight: 700
      }
    }, w.n), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 5,
        height: 5,
        borderRadius: 999,
        background: w.kcal ? on ? "var(--primary-foreground)" : "var(--primary)" : "transparent"
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 20px 0"
    }
  }, /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Total intake",
    value: "1,252",
    unit: "kcal"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 40,
      width: 1,
      background: "var(--border)"
    }
  }), /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Remaining",
    value: "748",
    unit: "kcal"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 40,
      width: 1,
      background: "var(--border)"
    }
  }), /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Water",
    value: "1.4",
    unit: "L"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)"
    }
  }, "Timeline"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      position: "relative",
      paddingLeft: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 5,
      top: 6,
      bottom: 6,
      width: 2,
      background: "var(--border)"
    }
  }), logged.map((m, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    onClick: () => onOpenMeal(m),
    style: {
      position: "relative",
      width: "100%",
      display: "flex",
      gap: 12,
      alignItems: "center",
      padding: "10px 0",
      background: "none",
      border: "none",
      cursor: "pointer",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      left: -18,
      top: 22,
      width: 10,
      height: 10,
      borderRadius: 999,
      background: "var(--primary)",
      border: "2px solid var(--background)"
    }
  }), /*#__PURE__*/React.createElement(FoodTile, {
    hue: m.hue,
    icon: m.icon,
    size: 48
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, m.time), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600
    }
  }, m.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)"
    }
  }, m.meta)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontWeight: 700,
      fontSize: 14
    }
  }, m.kcal))))));
}
window.DiaryScreen = DiaryScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/DiaryScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/HomeScreen.jsx
try { (() => {
/* Kora — Home. Conversational, Otto-led feed (NOT a calorie-tracker dashboard).
   Hero = Otto's coaching line + a capture prompt. Numbers are a compact secondary strip.
   Today reads as a feed of meals with inline Otto notes, not a data grid. */
const DS = window.TesserixDesignSystem_275930;
function FuelStrip({
  eaten,
  goal,
  macros
}) {
  const pct = Math.min(100, eaten / goal * 100);
  const M = [["P", macros.p, 140, 285], ["C", macros.c, 220, 45], ["F", macros.f, 70, 30]];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 16,
      padding: "14px 16px",
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)"
    }
  }, /*#__PURE__*/React.createElement(DS.CircularProgress, {
    value: eaten,
    max: goal,
    size: 54,
    stroke: 6,
    color: "var(--primary)"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 800,
      fontFamily: "var(--font-mono)"
    }
  }, Math.round(pct), "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 17,
      fontWeight: 800,
      fontFamily: "var(--font-mono)",
      letterSpacing: "-0.02em"
    }
  }, (goal - eaten).toLocaleString()), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)"
    }
  }, "kcal left \xB7 ", eaten.toLocaleString(), " of ", goal.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      marginTop: 6
    }
  }, M.map(([l, v, g, h]) => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      fontSize: 11,
      fontFamily: "var(--font-mono)",
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 999,
      background: `oklch(0.6 0.15 ${h})`
    }
  }), l, " ", v, "/", g, "g")))));
}
function FeedMeal({
  meal,
  onOpen
}) {
  const {
    FoodTile
  } = window;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onOpen,
    style: {
      width: "100%",
      display: "flex",
      gap: 14,
      alignItems: "center",
      padding: 12,
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)",
      cursor: "pointer",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement(FoodTile, {
    hue: meal.hue,
    icon: meal.icon,
    size: 60,
    radius: "var(--radius-lg)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, meal.time), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 700,
      letterSpacing: "-0.01em"
    }
  }, meal.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, meal.meta)), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 800,
      fontFamily: "var(--font-mono)"
    }
  }, meal.kcal), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, "kcal"))), meal.note && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "flex-start",
      padding: "0 4px 0 8px"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 14,
    color: "var(--primary)",
    style: {
      marginTop: 2
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12.5,
      color: "var(--muted-foreground)",
      lineHeight: 1.45
    }
  }, meal.note)));
}
function HomeScreen({
  data,
  onNav,
  onOpenMeal
}) {
  const eaten = data.meals.reduce((s, m) => s + (m.kcal || 0), 0);
  const goal = data.calorieGoal;
  const logged = data.meals.filter(m => m.kcal);
  const next = data.meals.find(m => !m.kcal);
  const NOTES = ["Solid protein start — kept you full till noon.", null, "Smart snack choice.", null];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 0 118px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "2px 20px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)"
    }
  }, "Wed \xB7 Jul 24"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: "var(--foreground)"
    }
  }, "Good evening, Alex")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("coach"),
    style: {
      width: 40,
      height: 40,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "message-circle",
    size: 19,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement(DS.Avatar, {
    initials: "AS",
    size: "md"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px 18px"
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontSize: 27,
      lineHeight: 1.18,
      fontWeight: 800,
      letterSpacing: "-0.03em",
      color: "var(--foreground)"
    }
  }, "You're ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--primary)"
    }
  }, (goal - eaten).toLocaleString(), " kcal"), " from a strong day."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "8px 0 0",
      fontSize: 14.5,
      lineHeight: 1.5,
      color: "var(--muted-foreground)"
    }
  }, "Protein's on track. A lean, high-protein dinner and you'll close every ring \u2014 want a suggestion?")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px 18px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("capture"),
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "14px 14px 14px 18px",
      borderRadius: "var(--radius-2xl)",
      border: "none",
      cursor: "pointer",
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      boxShadow: "var(--shadow-lg)",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 22,
    color: "var(--primary-foreground)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 15,
      fontWeight: 600
    }
  }, "Snap a meal or tell Otto what you ate\u2026"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      height: 34,
      borderRadius: "var(--radius-full)",
      background: "rgba(255,255,255,0.18)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "camera",
    size: 17,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      height: 34,
      borderRadius: "var(--radius-full)",
      background: "rgba(255,255,255,0.18)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "mic",
    size: 17,
    color: "var(--primary-foreground)"
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px 20px"
    }
  }, /*#__PURE__*/React.createElement(FuelStrip, {
    eaten: eaten,
    goal: goal,
    macros: data.macros
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)"
    }
  }, "Today"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 14,
      marginTop: 12
    }
  }, logged.map((m, i) => /*#__PURE__*/React.createElement(FeedMeal, {
    key: i,
    meal: {
      ...m,
      note: NOTES[i]
    },
    onOpen: () => onOpenMeal(m)
  })), next && /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("capture"),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: 16,
      borderRadius: "var(--radius-xl)",
      border: "1.5px dashed var(--border)",
      background: "transparent",
      cursor: "pointer",
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "plus",
    size: 20,
    color: "var(--primary)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--foreground)"
    }
  }, "Add dinner"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontSize: 12
    }
  }, "Snap \xB7 say \xB7 scan")))));
}
window.HomeScreen = HomeScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/HomeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/InsightsScreen.jsx
try { (() => {
/* Kora — Weekly Insights report. Distinctive summary, not a raw number dump. */
const DS = window.TesserixDesignSystem_275930;
const WEEK_KCAL = [1980, 2110, 1740, 2040, 1890, 1252, 0];
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const INSIGHTS = [{
  icon: "beef",
  hue: 285,
  label: "Protein consistency",
  value: "6 / 7 days",
  note: "Hit target all but Sunday"
}, {
  icon: "flame",
  hue: 30,
  label: "Avg calories",
  value: "1,921",
  note: "180 under goal — lean week"
}, {
  icon: "utensils",
  hue: 45,
  label: "Most-logged meal",
  value: "Chicken bowl",
  note: "4× this week"
}, {
  icon: "trophy",
  hue: 260,
  label: "Highest-protein day",
  value: "Tue · 168g",
  note: "Post-gym"
}, {
  icon: "timer",
  hue: 220,
  label: "Longest fast",
  value: "16h 40m",
  note: "Thursday"
}, {
  icon: "moon",
  hue: 280,
  label: "Best sleep",
  value: "8.1 h",
  note: "Friday night"
}];
function InsightsScreen({
  onNav
}) {
  const max = Math.max(...WEEK_KCAL);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background)"
    }
  }, /*#__PURE__*/React.createElement(window.StatusBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 18px 8px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("progress"),
    style: {
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-left",
    size: 19,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)"
    }
  }, "Jul 18 \u2013 24"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      letterSpacing: "-0.03em"
    }
  }, "Weekly report"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "8px 20px 24px"
    }
  }, /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 20,
      marginBottom: 16,
      background: "var(--primary)",
      border: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--primary-foreground)",
      opacity: 0.85,
      fontSize: 12,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.07em"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 15,
    color: "var(--primary-foreground)"
  }), "Otto's take"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "8px 0 0",
      fontSize: 18,
      lineHeight: 1.4,
      fontWeight: 700,
      color: "var(--primary-foreground)",
      letterSpacing: "-0.01em"
    }
  }, "Your most consistent week yet \u2014 protein steady and calories under goal six days running.")), /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 18,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)",
      marginBottom: 14
    }
  }, "Calories by day"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "space-between",
      height: 96,
      gap: 8
    }
  }, WEEK_KCAL.map((v, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      height: v ? `${v / max * 80}px` : 3,
      borderRadius: "var(--radius-sm)",
      background: v ? i === 5 ? "var(--primary)" : "color-mix(in oklch, var(--primary) 32%, transparent)" : "var(--border)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      color: "var(--muted-foreground)"
    }
  }, DAYS[i]))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, INSIGHTS.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 13,
      padding: 14,
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40,
      height: 40,
      borderRadius: "var(--radius-lg)",
      background: `oklch(0.95 0.045 ${it.hue})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: it.icon,
    size: 19,
    color: `oklch(0.52 0.13 ${it.hue})`
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, it.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)"
    }
  }, it.note)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 800,
      fontFamily: "var(--font-mono)",
      letterSpacing: "-0.01em"
    }
  }, it.value))))));
}
window.InsightsScreen = InsightsScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/InsightsScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/KoraApp.jsx
try { (() => {
/* Kora — app root. Wires screens, tab nav, meal sheet, and the AI capture flow.
   Props (tweaks): captureMode "both"|"chat". Renders inside the phone screen area. */
const DS = window.TesserixDesignSystem_275930;
const INITIAL_MEALS = [{
  name: "Overnight oats & berries",
  meta: "Oats · blueberries · almond butter",
  kcal: 388,
  hue: 20,
  icon: "wheat",
  time: "7:40 AM",
  items: [{
    name: "Rolled oats",
    grams: 60,
    kcal: 228,
    hue: 40,
    icon: "wheat"
  }, {
    name: "Blueberries",
    grams: 80,
    kcal: 46,
    hue: 280,
    icon: "cherry"
  }, {
    name: "Almond butter",
    grams: 16,
    kcal: 114,
    hue: 30,
    icon: "nut"
  }]
}, {
  name: "Chicken & quinoa bowl",
  meta: "Chicken · quinoa · avocado · greens",
  kcal: 512,
  hue: 45,
  icon: "salad",
  time: "12:55 PM"
}, {
  name: "Greek yogurt",
  meta: "Yogurt · honey",
  kcal: 152,
  hue: 220,
  icon: "milk",
  time: "3:30 PM"
}, {
  name: "Dinner",
  meta: "Tap to snap or ask Otto",
  kcal: null,
  hue: 285,
  icon: "utensils"
}];
function KoraApp({
  captureMode = "both"
}) {
  const {
    StatusBar,
    TabBar,
    Sheet,
    HomeScreen,
    DiaryScreen,
    ProgressScreen,
    AddonsScreen,
    CaptureScreen,
    CoachScreen,
    InsightsScreen,
    PlannerScreen,
    RestaurantScreen,
    Onboarding,
    MealDetailSheet
  } = window;
  const [onboarded, setOnboarded] = React.useState(false);
  const [tab, setTab] = React.useState("home");
  const [meals, setMeals] = React.useState(INITIAL_MEALS);
  const [sheetMeal, setSheetMeal] = React.useState(null);
  const eaten = meals.reduce((s, m) => s + (m.kcal || 0), 0);
  const data = {
    calorieGoal: 2000,
    macros: {
      p: 96 + Math.round(eaten * 0),
      c: 148,
      f: 44
    },
    meals
  };
  const logDinner = items => {
    const kcal = items.reduce((s, i) => s + i.kcal, 0);
    setMeals(prev => prev.map(m => m.kcal == null ? {
      ...m,
      name: "Grilled chicken plate",
      meta: items.map(i => i.name).join(" · "),
      kcal,
      time: "7:15 PM",
      icon: "drumstick",
      hue: 30,
      items
    } : m));
  };
  if (!onboarded) return /*#__PURE__*/React.createElement(Onboarding, {
    onStart: () => setOnboarded(true)
  });
  const scroll = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch"
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, tab === "capture" ? /*#__PURE__*/React.createElement(CaptureScreen, {
    mode: captureMode,
    onNav: setTab,
    onLog: logDinner
  }) : tab === "coach" ? /*#__PURE__*/React.createElement(CoachScreen, {
    onNav: setTab
  }) : tab === "insights" ? /*#__PURE__*/React.createElement(InsightsScreen, {
    onNav: setTab
  }) : tab === "planner" ? /*#__PURE__*/React.createElement(PlannerScreen, {
    onNav: setTab
  }) : tab === "restaurant" ? /*#__PURE__*/React.createElement(RestaurantScreen, {
    onNav: setTab
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: scroll
  }, /*#__PURE__*/React.createElement(StatusBar, null), tab === "home" && /*#__PURE__*/React.createElement(HomeScreen, {
    data: data,
    onNav: setTab,
    onOpenMeal: setSheetMeal
  }), tab === "diary" && /*#__PURE__*/React.createElement(DiaryScreen, {
    data: data,
    onOpenMeal: setSheetMeal
  }), tab === "progress" && /*#__PURE__*/React.createElement(ProgressScreen, {
    onNav: setTab
  }), tab === "addons" && /*#__PURE__*/React.createElement(AddonsScreen, {
    onNav: setTab
  })), /*#__PURE__*/React.createElement(TabBar, {
    active: tab,
    onNav: setTab
  })), /*#__PURE__*/React.createElement(Sheet, {
    open: !!sheetMeal,
    onClose: () => setSheetMeal(null)
  }, sheetMeal && /*#__PURE__*/React.createElement(MealDetailSheet, {
    meal: sheetMeal,
    onClose: () => setSheetMeal(null)
  })));
}
window.KoraApp = KoraApp;
window.KORA_MEALS = INITIAL_MEALS;
window.KORA_DATA = {
  calorieGoal: 2000,
  macros: {
    p: 96,
    c: 148,
    f: 44
  },
  meals: INITIAL_MEALS
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/KoraApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/MealDetail.jsx
try { (() => {
/* Kora — Meal detail sheet content. Editable item list + macro summary. */
const DS = window.TesserixDesignSystem_275930;
function Stepper({
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(Math.max(0, value - 10)),
    style: {
      width: 28,
      height: 28,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "minus",
    size: 14,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      fontWeight: 700,
      minWidth: 44,
      textAlign: "center"
    }
  }, value, "g"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(value + 10),
    style: {
      width: 28,
      height: 28,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "plus",
    size: 14,
    color: "var(--foreground)"
  })));
}
function MealDetailSheet({
  meal,
  onClose
}) {
  const {
    FoodTile
  } = window;
  const items = meal.items || [{
    name: "Grilled chicken breast",
    grams: 140,
    kcal: 231,
    hue: 30,
    icon: "drumstick"
  }, {
    name: "Steamed broccoli",
    grams: 90,
    kcal: 31,
    hue: 150,
    icon: "leaf"
  }, {
    name: "Brown rice",
    grams: 120,
    kcal: 148,
    hue: 70,
    icon: "wheat"
  }];
  const [g, setG] = React.useState(items.map(i => i.grams));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 22px 30px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 0 18px"
    }
  }, /*#__PURE__*/React.createElement(FoodTile, {
    hue: meal.hue,
    icon: meal.icon,
    size: 64,
    radius: "var(--radius-xl)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.07em"
    }
  }, meal.name, " \xB7 ", meal.time), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 24,
      fontWeight: 800,
      letterSpacing: "-0.03em"
    }
  }, meal.kcal, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, "kcal"))), /*#__PURE__*/React.createElement(DS.Badge, {
    variant: "success"
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 12,
    color: "var(--success-muted-foreground)"
  }), "AI logged")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 18
    }
  }, [["Protein", "48g", 155], ["Carbs", "132g", 70], ["Fat", "12g", 30]].map(([l, v, h]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      flex: 1,
      background: `oklch(0.96 0.03 ${h})`,
      borderRadius: "var(--radius-lg)",
      padding: "10px 12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 800,
      fontFamily: "var(--font-mono)",
      color: `oklch(0.42 0.12 ${h})`
    }
  }, v)))), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)"
    }
  }, "Items"), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "8px 0 20px"
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "12px 0",
      borderBottom: i < items.length - 1 ? "1px solid var(--border)" : "none"
    }
  }, /*#__PURE__*/React.createElement(FoodTile, {
    hue: it.hue,
    icon: it.icon,
    size: 40
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, it.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, it.kcal, " kcal")), /*#__PURE__*/React.createElement(Stepper, {
    value: g[i],
    onChange: v => setG(g.map((x, j) => j === i ? v : x))
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(DS.Button, {
    variant: "outline",
    style: {
      flex: "0 0 auto"
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "trash-2",
    size: 16,
    color: "var(--destructive)"
  })), /*#__PURE__*/React.createElement(DS.Button, {
    style: {
      flex: 1
    },
    onClick: onClose
  }, "Save changes")));
}
window.MealDetailSheet = MealDetailSheet;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/MealDetail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/Onboarding.jsx
try { (() => {
/* Kora — Onboarding / goal setup (entry screen). */
const DS = window.TesserixDesignSystem_275930;
const GOALS = [{
  id: "lose",
  icon: "trending-down",
  title: "Lose weight",
  sub: "Gentle calorie deficit"
}, {
  id: "maintain",
  icon: "minus",
  title: "Maintain",
  sub: "Stay where you are"
}, {
  id: "gain",
  icon: "trending-up",
  title: "Build muscle",
  sub: "Lean surplus + protein"
}];
function Onboarding({
  onStart
}) {
  const [goal, setGoal] = React.useState("lose");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background)"
    }
  }, window.StatusBar ? /*#__PURE__*/React.createElement(window.StatusBar, null) : /*#__PURE__*/React.createElement("div", {
    style: {
      height: 54
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "8px 24px 24px",
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40,
      height: 40,
      borderRadius: "var(--radius-lg)",
      background: "var(--primary)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "var(--shadow-md)"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 22,
    color: "var(--primary-foreground)"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      letterSpacing: "-0.02em",
      color: "var(--foreground)"
    }
  }, "Kora")), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontSize: 32,
      fontWeight: 800,
      letterSpacing: "-0.035em",
      lineHeight: 1.05,
      color: "var(--foreground)"
    }
  }, "Snap it.", /*#__PURE__*/React.createElement("br", null), "Otto tracks it."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "12px 0 26px",
      fontSize: 16,
      lineHeight: 1.5,
      color: "var(--muted-foreground)"
    }
  }, "Photo or chat \u2014 log meals in seconds and let AI handle the calories and macros."), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--muted-foreground)",
      marginBottom: 12
    }
  }, "What's your goal?"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, GOALS.map(g => {
    const on = goal === g.id;
    return /*#__PURE__*/React.createElement("button", {
      key: g.id,
      onClick: () => setGoal(g.id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: 16,
        borderRadius: "var(--radius-xl)",
        cursor: "pointer",
        textAlign: "left",
        background: "var(--card)",
        border: on ? "2px solid var(--primary)" : "2px solid var(--border)",
        boxShadow: on ? "var(--shadow-md)" : "none",
        transition: "var(--transition-all)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 42,
        height: 42,
        borderRadius: "var(--radius-lg)",
        background: on ? "var(--primary)" : "var(--secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement(DS.Icon, {
      name: g.icon,
      size: 20,
      color: on ? "var(--primary-foreground)" : "var(--primary)"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 16,
        fontWeight: 700,
        color: "var(--foreground)"
      }
    }, g.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: "var(--muted-foreground)"
      }
    }, g.sub)), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 22,
        height: 22,
        borderRadius: 999,
        border: on ? "none" : "2px solid var(--border)",
        background: on ? "var(--primary)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, on && /*#__PURE__*/React.createElement(DS.Icon, {
      name: "check",
      size: 14,
      color: "var(--primary-foreground)"
    })));
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 24px 30px",
      borderTop: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(DS.Button, {
    size: "lg",
    style: {
      width: "100%"
    },
    onClick: onStart
  }, "Get started", /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-right",
    size: 18,
    color: "var(--primary-foreground)"
  }))));
}
window.Onboarding = Onboarding;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/Onboarding.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/PlannerScreen.jsx
try { (() => {
/* Kora — AI Meal Planner. Otto generates a day plan from constraints. */
const DS = window.TesserixDesignSystem_275930;
const PLAN = [{
  slot: "Breakfast",
  name: "Greek yogurt, berries & granola",
  kcal: 380,
  p: 28,
  hue: 220,
  icon: "milk"
}, {
  slot: "Lunch",
  name: "Chicken & quinoa power bowl",
  kcal: 540,
  p: 46,
  hue: 45,
  icon: "salad"
}, {
  slot: "Snack",
  name: "Protein shake & apple",
  kcal: 260,
  p: 30,
  hue: 285,
  icon: "cup-soda"
}, {
  slot: "Dinner",
  name: "Baked salmon, greens & potatoes",
  kcal: 620,
  p: 44,
  hue: 30,
  icon: "fish"
}];
function PlannerScreen({
  onNav
}) {
  const [active, setActive] = React.useState(["High protein", "~1,800 kcal", "30 min"]);
  const total = PLAN.reduce((s, p) => s + p.kcal, 0);
  const protein = PLAN.reduce((s, p) => s + p.p, 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background)"
    }
  }, /*#__PURE__*/React.createElement(window.StatusBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 18px 8px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("addons"),
    style: {
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-left",
    size: 19,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)"
    }
  }, "Powered by Otto"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      letterSpacing: "-0.03em"
    }
  }, "Meal plan"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "8px 20px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 18
    }
  }, ["High protein", "~1,800 kcal", "30 min", "Mediterranean", "Budget"].map(c => {
    const on = active.includes(c);
    return /*#__PURE__*/React.createElement("button", {
      key: c,
      onClick: () => setActive(on ? active.filter(x => x !== c) : [...active, c]),
      style: {
        border: on ? "1px solid var(--primary)" : "1px solid var(--border)",
        background: on ? "color-mix(in oklch, var(--primary) 12%, transparent)" : "var(--card)",
        color: on ? "var(--primary)" : "var(--muted-foreground)",
        borderRadius: "var(--radius-full)",
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer"
      }
    }, c);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: "var(--secondary)",
      borderRadius: "var(--radius-lg)",
      padding: "12px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, "Total"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      fontFamily: "var(--font-mono)"
    }
  }, total.toLocaleString(), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, "kcal"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: "var(--secondary)",
      borderRadius: "var(--radius-lg)",
      padding: "12px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, "Protein"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      fontFamily: "var(--font-mono)"
    }
  }, protein, "g"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, PLAN.map((p, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      gap: 13,
      alignItems: "center",
      padding: 12,
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)"
    }
  }, /*#__PURE__*/React.createElement(window.FoodTile, {
    hue: p.hue,
    icon: p.icon,
    size: 54
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.06em"
    }
  }, p.slot), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14.5,
      fontWeight: 700,
      letterSpacing: "-0.01em"
    }
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, p.kcal, " kcal \xB7 ", p.p, "g protein")), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 32,
      height: 32,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "rotate-cw",
    size: 15,
    color: "var(--muted-foreground)"
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement(DS.Button, {
    variant: "outline",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 16,
    color: "var(--foreground)"
  }), "Regenerate"), /*#__PURE__*/React.createElement(DS.Button, {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "shopping-cart",
    size: 16,
    color: "var(--primary-foreground)"
  }), "Shopping list"))));
}
window.PlannerScreen = PlannerScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/PlannerScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/ProgressScreen.jsx
try { (() => {
/* Kora — Progress. Weight trend chart + key stats. */
const DS = window.TesserixDesignSystem_275930;
const WEIGHTS = [74.2, 74.0, 73.6, 73.7, 73.1, 72.8, 72.4];
const LABELS = ["Jul 17", "", "Jul 19", "", "Jul 21", "", "Jul 23"];
function WeightChart() {
  const w = 300,
    h = 130,
    pad = 10;
  const min = Math.min(...WEIGHTS) - 0.4,
    max = Math.max(...WEIGHTS) + 0.4;
  const x = i => pad + i * (w - pad * 2) / (WEIGHTS.length - 1);
  const y = v => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const pts = WEIGHTS.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${h - pad} ${pts} ${x(WEIGHTS.length - 1)},${h - pad}`;
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    style: {
      width: "100%",
      height: "auto",
      display: "block"
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "wg",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "var(--primary)",
    stopOpacity: "0.22"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "var(--primary)",
    stopOpacity: "0"
  }))), /*#__PURE__*/React.createElement("polygon", {
    points: area,
    fill: "url(#wg)"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: pts,
    fill: "none",
    stroke: "var(--primary)",
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }), WEIGHTS.map((v, i) => /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: x(i),
    cy: y(v),
    r: i === WEIGHTS.length - 1 ? 4.5 : 2.5,
    fill: "var(--primary)",
    stroke: "var(--background)",
    strokeWidth: "1.5"
  })));
}
function ProgressScreen({
  onNav
}) {
  const {
    ScreenHeader
  } = window;
  const [range, setRange] = React.useState("1W");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 0 118px"
    }
  }, /*#__PURE__*/React.createElement(ScreenHeader, {
    overline: "Trends",
    title: "Progress",
    right: /*#__PURE__*/React.createElement(DS.Button, {
      variant: "outline",
      size: "sm",
      onClick: () => onNav && onNav("insights")
    }, /*#__PURE__*/React.createElement(DS.Icon, {
      name: "sparkles",
      size: 15,
      color: "var(--foreground)"
    }), "Weekly report")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 20px",
      display: "flex",
      flexDirection: "column",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontWeight: 600
    }
  }, "Weight"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 30,
      fontWeight: 800,
      letterSpacing: "-0.03em",
      fontFamily: "var(--font-mono)"
    }
  }, "72.4"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: "var(--muted-foreground)"
    }
  }, "kg"))), /*#__PURE__*/React.createElement(DS.Badge, {
    variant: "success"
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "trending-down",
    size: 13,
    color: "var(--success-muted-foreground)"
  }), "1.8 kg")), /*#__PURE__*/React.createElement(WeightChart, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      marginTop: 4
    }
  }, LABELS.map((l, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      fontSize: 9,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, l))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginTop: 14
    }
  }, ["1W", "1M", "3M", "1Y"].map(r => /*#__PURE__*/React.createElement("button", {
    key: r,
    onClick: () => setRange(r),
    style: {
      flex: 1,
      padding: "7px 0",
      borderRadius: "var(--radius-md)",
      border: "none",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700,
      fontFamily: "var(--font-mono)",
      background: range === r ? "var(--secondary)" : "transparent",
      color: range === r ? "var(--primary)" : "var(--muted-foreground)"
    }
  }, r)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Avg intake",
    value: "1,921",
    unit: "kcal",
    delta: "On target",
    trend: "down"
  })), /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Log streak",
    value: "12",
    unit: "days",
    delta: "Personal best",
    trend: "up"
  })), /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Avg steps",
    value: "8,240",
    delta: "+6% wk",
    trend: "up"
  })), /*#__PURE__*/React.createElement(DS.Card, {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(DS.Stat, {
    label: "Avg sleep",
    value: "7.1",
    unit: "hrs"
  })))));
}
window.ProgressScreen = ProgressScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/ProgressScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/kora/RestaurantScreen.jsx
try { (() => {
/* Kora — Restaurant mode. Search chains; AI imports/estimates nutrition. */
const DS = window.TesserixDesignSystem_275930;
const CHAINS = ["Nando's", "Subway", "McDonald's", "KFC", "Chipotle", "Pret"];
const MENU = [{
  name: "1/4 Chicken, skin off",
  meta: "Nando's",
  kcal: 285,
  p: 44,
  hue: 30,
  verified: true
}, {
  name: "PERi-PERi chips (regular)",
  meta: "Nando's",
  kcal: 342,
  p: 6,
  hue: 45,
  verified: true
}, {
  name: "Grilled corn on the cob",
  meta: "Nando's",
  kcal: 140,
  p: 4,
  hue: 70,
  verified: false
}, {
  name: "Spicy rice",
  meta: "Nando's",
  kcal: 232,
  p: 5,
  hue: 20,
  verified: false
}];
function RestaurantScreen({
  onNav
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background)"
    }
  }, /*#__PURE__*/React.createElement(window.StatusBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 18px 10px"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("addons"),
    style: {
      width: 36,
      height: 36,
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "arrow-left",
    size: 19,
    color: "var(--foreground)"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      fontWeight: 700,
      color: "var(--muted-foreground)"
    }
  }, "Eating out"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 800,
      letterSpacing: "-0.03em"
    }
  }, "Restaurants"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 18px 12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      background: "var(--secondary)",
      borderRadius: "var(--radius-full)",
      padding: "11px 16px"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "search",
    size: 18,
    color: "var(--muted-foreground)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      color: "var(--muted-foreground)"
    }
  }, "Search a restaurant or dish\u2026"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "4px 20px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      overflowX: "auto",
      paddingBottom: 16
    }
  }, CHAINS.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: c,
    style: {
      flex: "0 0 auto",
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 14px",
      borderRadius: "var(--radius-full)",
      border: i === 0 ? "1px solid var(--primary)" : "1px solid var(--border)",
      background: i === 0 ? "color-mix(in oklch, var(--primary) 12%, transparent)" : "var(--card)",
      color: i === 0 ? "var(--primary)" : "var(--foreground)",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "store",
    size: 15,
    color: i === 0 ? "var(--primary)" : "var(--muted-foreground)"
  }), c))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700
    }
  }, "Nando's \xB7 popular"), /*#__PURE__*/React.createElement(DS.Badge, {
    variant: "info"
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 12,
    color: "var(--info-muted-foreground)"
  }), "AI-matched")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, MENU.map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      gap: 13,
      alignItems: "center",
      padding: 13,
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)"
    }
  }, /*#__PURE__*/React.createElement(window.FoodTile, {
    hue: m.hue,
    icon: "utensils",
    size: 46
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14.5,
      fontWeight: 700,
      letterSpacing: "-0.01em"
    }
  }, m.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)"
    }
  }, m.kcal, " kcal \xB7 ", m.p, "g protein \xB7 ", m.verified ? "verified" : "≈ estimated")), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 32,
      height: 32,
      borderRadius: "var(--radius-full)",
      border: "none",
      background: "var(--primary)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "plus",
    size: 16,
    color: "var(--primary-foreground)"
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      display: "flex",
      gap: 10,
      alignItems: "flex-start",
      padding: 14,
      borderRadius: "var(--radius-lg)",
      background: "var(--accent)",
      border: "1px solid color-mix(in oklch, var(--primary) 20%, transparent)"
    }
  }, /*#__PURE__*/React.createElement(DS.Icon, {
    name: "sparkles",
    size: 16,
    color: "var(--primary)",
    style: {
      marginTop: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--foreground)",
      lineHeight: 1.45
    }
  }, "No official data? Otto estimates from a photo or the dish description \u2014 flagged as approximate."))));
}
window.RestaurantScreen = RestaurantScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/kora/RestaurantScreen.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.CardHeader = __ds_scope.CardHeader;

__ds_ns.CardTitle = __ds_scope.CardTitle;

__ds_ns.CardDescription = __ds_scope.CardDescription;

__ds_ns.CardContent = __ds_scope.CardContent;

__ds_ns.CardFooter = __ds_scope.CardFooter;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Separator = __ds_scope.Separator;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Callout = __ds_scope.Callout;

__ds_ns.CircularProgress = __ds_scope.CircularProgress;

__ds_ns.Progress = __ds_scope.Progress;

__ds_ns.Skeleton = __ds_scope.Skeleton;

__ds_ns.Stat = __ds_scope.Stat;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Switch = __ds_scope.Switch;

})();
