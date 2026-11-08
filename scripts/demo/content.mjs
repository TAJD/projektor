const report = (summary, verification, prLink) => ({
	summary,
	verification,
	...(prLink ? { prLink } : {}),
});

export const PROJECTS = [
	{
		name: "Storefront",
		key: "SHOP",
		description: "The customer-facing web shop: catalogue, basket and checkout.",
		issues: [
			{
				ref: "checkout",
				title: "Guest checkout",
				type: "epic",
				status: "in_progress",
				priority: "high",
				labels: ["checkout"],
				body: "Let shoppers pay without creating an account. Account creation becomes an optional step after the order is placed.\n\n## Done when\n- A guest can complete an order end to end\n- The order confirmation email offers to create an account\n- Conversion is tracked separately for guest and signed-in orders",
			},
			{
				ref: "guest-form",
				parent: "checkout",
				title: "Collect email and address on the guest checkout form",
				type: "story",
				status: "done",
				priority: "high",
				labels: ["checkout", "frontend"],
				body: "One form for email, shipping address and billing address (with a 'same as shipping' toggle). Validate the postcode against the country.",
				report: report(
					"Added the guest details form with inline validation and the 'same as shipping' toggle.",
					"Unit tests for the postcode rules; checked the form at 390px and desktop.",
					"https://github.com/example/storefront/pull/412"
				),
			},
			{
				ref: "guest-payment",
				parent: "checkout",
				title: "Take payment for a guest order",
				type: "story",
				status: "in_review",
				priority: "high",
				labels: ["checkout", "payments"],
				body: "Create the payment intent without a customer record, and attach the order to the email address instead.",
				report: report(
					"Payment intents for guests are created against the order, not a customer. Refunds work from the order page.",
					"Integration tests against the payment provider's test mode, including a declined card and a 3-D Secure challenge.",
					"https://github.com/example/storefront/pull/418"
				),
				comments: [
					"Can we make sure the order page shows the last four digits for guests too? Support asks for it.",
				],
			},
			{
				ref: "guest-email",
				parent: "checkout",
				title: "Offer account creation in the order confirmation email",
				type: "story",
				status: "in_progress",
				priority: "medium",
				labels: ["checkout", "email"],
				links: [{ type: "blocked_by", target: "guest-payment" }],
			},
			{
				ref: "guest-metrics",
				parent: "checkout",
				title: "Track guest and signed-in conversion separately",
				type: "task",
				status: "todo",
				priority: "medium",
				labels: ["checkout", "analytics"],
			},
			{
				ref: "basket-bug",
				title: "Basket total ignores a discount code applied before sign-in",
				type: "bug",
				status: "done",
				priority: "urgent",
				labels: ["basket"],
				body: "Steps: add an item, apply SAVE10, then sign in. The basket keeps the code but the total is the undiscounted price.\n\nExpected: the discount survives sign-in.",
				report: report(
					"Re-applied basket-level discounts when the anonymous basket merges into the account's basket.",
					"Regression test for the merge path; reproduced the bug first, then confirmed the fix.",
					"https://github.com/example/storefront/pull/405"
				),
			},
			{
				ref: "image-sizes",
				title: "Serve product images at the size the grid actually renders",
				type: "task",
				status: "todo",
				priority: "medium",
				labels: ["performance", "frontend"],
				body: "The catalogue grid downloads 1600px images and shows them at 320px. Use responsive srcset sizes.",
			},
			{
				ref: "search-typo",
				title: "Search returns nothing for common misspellings",
				type: "bug",
				status: "backlog",
				priority: "low",
				labels: ["search"],
				comments: ["'trainres' and 'jaket' are the top two zero-result queries this month."],
			},
			{
				ref: "currency",
				title: "Show prices in the shopper's local currency",
				type: "story",
				status: "backlog",
				priority: "low",
				labels: ["i18n"],
			},
			{
				ref: "old-carousel",
				title: "Replace the home page carousel",
				type: "task",
				status: "cancelled",
				priority: "none",
				labels: ["frontend"],
				comments: ["Dropped: the redesign removes the carousel entirely."],
			},
		],
	},
	{
		name: "Mobile app",
		key: "MOB",
		description: "The iOS and Android shopping app.",
		issues: [
			{
				ref: "push",
				title: "Back-in-stock push notifications",
				type: "story",
				status: "in_progress",
				priority: "high",
				labels: ["notifications"],
				body: "Let a shopper tap 'notify me' on a sold-out product and get a push when it is restocked.",
			},
			{
				ref: "push-opt-in",
				title: "Ask for notification permission only after 'notify me' is tapped",
				type: "task",
				status: "in_review",
				priority: "medium",
				labels: ["notifications", "ux"],
				links: [{ type: "relates_to", target: "push" }],
				report: report(
					"Moved the permission prompt from app launch to the first 'notify me' tap, with a short explanation screen first.",
					"Tested on iOS 18 and Android 15 emulators, including the 'denied' path."
				),
			},
			{
				ref: "crash",
				title: "App crashes when the basket has more than 50 items",
				type: "bug",
				status: "todo",
				priority: "urgent",
				labels: ["basket", "crash"],
				body: "Crash reports point at the basket list's recycler. Only seen on Android.",
			},
			{
				ref: "dark-mode",
				title: "Dark mode",
				type: "story",
				status: "done",
				priority: "medium",
				labels: ["ux"],
				report: report(
					"Added a dark theme that follows the system setting, with tokens shared with the web design system.",
					"Screenshot tests for every screen in both themes."
				),
			},
		],
	},
];

export const WIKI_PAGES = [
	{
		slug: "welcome",
		title: "Welcome",
		content:
			"# Welcome to the Projektor demo\n\nThis is a read-only copy of a small product team's workspace: a web shop (**SHOP**) and its mobile app (**MOB**).\n\n- Browse the Storefront and Mobile app boards to see work in every state, from backlog to done.\n- Open an issue in review to see the completion report an agent filed when it handed the work over.\n- See [[How we work]] for the workflow these projects follow.\n\nThe content is reset with every Projektor release.",
	},
	{
		slug: "how-we-work",
		title: "How we work",
		content:
			"# How we work\n\n1. Issues start in **Backlog**. Moving one to **Todo** means it is ready: it has a clear outcome and nothing blocks it.\n2. An agent claims an issue, does the work, and moves it to **In Review** with a completion report: what changed, how it was verified, and a link to the pull request.\n3. A person reviews it and either approves it (**Done**) or sends it back with a comment.\n\nWork in progress is capped per agent, so finishing beats starting.",
	},
	{
		slug: "release-checklist",
		title: "Release checklist",
		content:
			"# Release checklist\n\n- [ ] Every issue in the release is **Done**, not just merged\n- [ ] Payments run against test mode in staging\n- [ ] The mobile build is in TestFlight and the internal track\n- [ ] Release notes drafted from the completion reports",
	},
];
