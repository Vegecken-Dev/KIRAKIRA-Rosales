export default {
  SendVerificationCode: {
    mailTitle: "KIRAKIRA - 注册验证码",
    mailHtml: `
					<p>你的注册验证码是：<strong>{{verificationCode}}</strong></p>
					欢迎来到 KIRAKIRA，使用这个验证码来完成注册吧！
					<br>
					验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
				`,
  },

  SendChangeEmailVerificationCode: {
    mailTitle: "KIRAKIRA - 更改邮箱验证码",
    mailHtml: `
					<p>你更改邮箱的验证码是：<strong>{{verificationCode}}</strong></p>
					<br>
					证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
        `,
  },

  SendChangePasswordVerificationCode: {
    mailTitle: "KIRAKIRA - 更改密码验证码",
    mailHtml: `
					<p>你更改密码的验证码是：<strong>{{verificationCode}}</strong></p>
					<br>
					验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
				`,
  },

  UserEmailAuthenticator: {
    mailTitle: "KIRAKIRA - 验证 2FA 的验证码",
    mailHtml: `
					<p>验证 2FA 的验证码是：<strong>{{verificationCode}}</strong></p>
					注意：你可以使用这个验证码来验证你的 2FA（二重身份验证器）。
					<br>
					验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
				`,
  },

  DeleteUserEmailAuthenticator: {
    mailTitle: "KIRAKIRA - 删除 2FA 的验证码",
    mailHtml: `
          <p>删除 2FA 的验证码是：<strong>{{verificationCode}}</strong></p>
          注意：你可以使用这个验证码来删除你的 2FA（二重身份验证器）。
          <br>
          验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
        `,
  },


} as const;