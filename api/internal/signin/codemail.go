package signin

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"strings"

	"github.com/tesserix/kora/api/internal/mail"
)

// Mailer sends Kora's own code emails. Nil leaves Zitadel mailing them, with
// its shared template: a "Reset password" button into the hosted web login,
// which an app-only product has no use for.
type Mailer interface {
	Send(ctx context.Context, m mail.Message) error
}

type codeKind int

const (
	verifyCode codeKind = iota
	resetCode
)

// The copy for each kind. Both codes expire after an hour: Zitadel's default
// for its email and password verification generators, which Tesserix does
// not override.
var codeCopy = map[codeKind]struct {
	subject, lead, ignore string
}{
	verifyCode: {
		subject: "%s is your Kora confirmation code",
		lead:    "Enter this code in Kora to confirm your email address.",
		ignore:  "If you didn't create a Kora account, you can ignore this email.",
	},
	resetCode: {
		subject: "%s is your Kora password reset code",
		lead:    "Enter this code in Kora to choose a new password.",
		ignore:  "If you didn't ask to reset your password, you can ignore this email. Your password hasn't changed.",
	},
}

// codeEmail builds the email carrying code. There is deliberately no button
// or link: the code is typed into the app, and the subject leads with it so
// it reads from the notification alone.
func codeEmail(kind codeKind, to, name, code string) (mail.Message, error) {
	c := codeCopy[kind]
	greeting := "Hi,"
	if first := strings.TrimSpace(name); first != "" {
		greeting = "Hi " + first + ","
	}
	data := map[string]string{
		"Greeting": greeting,
		"Lead":     c.lead,
		"Code":     code,
		"Expiry":   "It expires in an hour.",
		"Ignore":   c.ignore,
	}
	var html bytes.Buffer
	if err := codeHTML.Execute(&html, data); err != nil {
		return mail.Message{}, fmt.Errorf("signin: render code email: %w", err)
	}
	text := strings.Join([]string{greeting, "", c.lead, "", code, "", data["Expiry"], c.ignore, "", "Kora by Tesserix"}, "\n")
	return mail.Message{
		To:      to,
		Subject: fmt.Sprintf(c.subject, code),
		Text:    text,
		HTML:    html.String(),
	}, nil
}

// Light, inline-styled and table-free: mail clients drop <style> blocks and
// many force a light background. Ink and accent are the app's light palette.
var codeHTML = template.Must(template.New("code").Parse(`<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1C20;">
<div style="max-width:440px;margin:0 auto;background:#FFFFFF;border-radius:16px;padding:32px 28px;">
<div style="font-size:13px;font-weight:700;letter-spacing:3px;color:#D23800;">KORA</div>
<p style="font-size:17px;margin:24px 0 8px;">{{.Greeting}}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px;color:#3A3D44;">{{.Lead}}</p>
<div style="font-family:Menlo,Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px 0;background:#F4F1EA;border-radius:10px;">{{.Code}}</div>
<p style="font-size:13px;line-height:1.5;margin:20px 0 0;color:#6B6F78;">{{.Expiry}} {{.Ignore}}</p>
</div>
<p style="max-width:440px;margin:16px auto 0;text-align:center;font-size:12px;color:#8A8D94;">Kora by Tesserix</p>
</body></html>
`))
