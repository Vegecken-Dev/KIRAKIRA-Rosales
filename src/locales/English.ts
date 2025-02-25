export default {
  SendVerificationCode: {
    mailTitle: "KIRAKIRA - Registration Verification Code",
    mailHtml: `
					<p>Your registration verification code is: <strong>{{verificationCode}}</strong></p>
					Welcome to KIRAKIRA. You can use this verification code to register your account.
				  <br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
				`,
  },

  SendChangeEmailVerificationCode: {
    mailTitle: "KIRAKIRA - Change Email Verification Code",
    mailHtml: `
					<p>Your change email verification code is: <strong>{{verificationCode}}</strong></p>
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
        `,
  },

  SendChangePasswordVerificationCode: {
    mailTitle: "KIRAKIRA - Change Password Verification Code",
    mailHtml: `
					<p>Your change password verification code is: <strong>{{verificationCode}}</strong></p>
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
				`,
  },

  UserEmailAuthenticator: {
    mailTitle: "KIRAKIRA - Verification Code For Verifying 2FA",
    mailHtml: `
					<p>Your verification code for verifying Authenticator is: <strong>{{verificationCode}}</strong></p>
					Note: Please make sure you will use this verification code to verify your Authenticator.
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
				`,
  },

  DeleteUserEmailAuthenticator: {
    mailTitle: "KIRAKIRA - Verification Code for Deleting 2FA",
    mailHtml: `
          <p>Your verification code for deleting Authenticator is: <strong>{{verificationCode}}</strong></p>
					Note: Please make sure you will use this verification code to delete your Authenticator.
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
        `,
  },
} as const;