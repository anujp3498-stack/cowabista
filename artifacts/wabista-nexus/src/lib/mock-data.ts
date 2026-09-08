// Mock Data for Wabista Nexus
// Contacts, Phone Numbers, Templates, Campaigns, Campaign Routes, Overview stats,
// and Team & Roles are now backed by the real API — see the generated React
// Query hooks in @workspace/api-client-react.
//
// Inbox, Automations, Billing, and Analytics remain out of scope for this
// milestone and stay on mock data below.

export const threads = [
  { threadId: "th_1", contactName: "Sarah Jenkins", phone: "+1 415 555 2671", lastMessage: "Yes, please update my shipping address.", time: "2m ago", unread: 1, status: "Open" },
  { threadId: "th_2", contactName: "Elena Rodriguez", phone: "+34 600 123 456", lastMessage: "Gracias! I will check the catalog now.", time: "15m ago", unread: 0, status: "Resolved" },
  { threadId: "th_3", contactName: "David Okafor", phone: "+234 803 123 4567", lastMessage: "Can someone help me with the API integration?", time: "1h ago", unread: 2, status: "Open" },
  { threadId: "th_4", contactName: "+49 151 1234 5678", phone: "+49 151 1234 5678", lastMessage: "STOP", time: "3h ago", unread: 0, status: "Archived" },
  { threadId: "th_5", contactName: "Maria Garcia", phone: "+52 55 1234 5678", lastMessage: "I haven't received my discount code.", time: "5h ago", unread: 1, status: "Open" },
]

export const automations = [
  { id: "aut_1", name: "New User Onboarding", trigger: "Tag Added", condition: "Tag == 'New_Lead'", action: "Send Template: welcome_v1", status: "Active", lastTriggered: "10 mins ago" },
  { id: "aut_2", name: "Cart Abandonment Reminder", trigger: "Event Received", condition: "Event == 'cart_abandon' && Time > 2h", action: "Send Template: cart_reminder", status: "Active", lastTriggered: "2 mins ago" },
  { id: "aut_3", name: "Auto-Reply: Out of Office", trigger: "Inbound Message", condition: "Time < 09:00 OR Time > 17:00", action: "Send Template: ooo_reply", status: "Paused", lastTriggered: "Yesterday" },
  { id: "aut_4", name: "Opt-Out Handler", trigger: "Inbound Message", condition: "Message EXACTLY 'STOP'", action: "Update Contact: Status = Unsubscribed", status: "Active", lastTriggered: "3 hours ago" },
  { id: "aut_5", name: "High Value Escalation", trigger: "Inbound Message", condition: "Contact Tag CONTAINS 'VIP'", action: "Route to: Priority Inbox", status: "Active", lastTriggered: "1 hour ago" },
]

export const apiKeys = [
  { id: "key_1", name: "Production Gateway", masked: "sk_live_****a9b2", created: "Jan 10, 2023", lastUsed: "Just now", scopes: ["sending:write", "contacts:read"] },
  { id: "key_2", name: "Zendesk Integration", masked: "sk_live_****f7c1", created: "Mar 15, 2023", lastUsed: "5 mins ago", scopes: ["messages:read", "messages:write"] },
  { id: "key_3", name: "Staging Testing", masked: "sk_test_****8d3e", created: "Oct 20, 2023", lastUsed: "2 days ago", scopes: ["*"] },
]

export const webhooks = [
  { id: "wh_1", url: "https://api.acme.corp/webhooks/whatsapp", events: ["message.received", "message.delivered", "message.read"], status: "Active" },
  { id: "wh_2", url: "https://zapier.com/hooks/catch/12345", events: ["contact.created", "contact.updated"], status: "Active" },
  { id: "wh_3", url: "https://analytics.acme.corp/ingest", events: ["campaign.completed"], status: "Failing" },
]

export const invoices = [
  { id: "inv_1024", period: "Oct 2023", amount: 4500.00, status: "Paid", date: "Nov 01, 2023" },
  { id: "inv_1023", period: "Sep 2023", amount: 4250.50, status: "Paid", date: "Oct 01, 2023" },
  { id: "inv_1022", period: "Aug 2023", amount: 3900.00, status: "Paid", date: "Sep 01, 2023" },
  { id: "inv_1025", period: "Nov 2023", amount: 5100.00, status: "Pending", date: "Dec 01, 2023" },
]

export const activityFeed = [
  { id: "act_1", user: "Alice Johnson", action: "started campaign", target: "Q4 Black Friday Warmup", time: "10 mins ago" },
  { id: "act_2", user: "System", action: "throttled route", target: "+44 7700 900077 (UK Support & Ops)", time: "15 mins ago" },
  { id: "act_3", user: "John Smith", action: "created template", target: "latam_onboarding_es", time: "1 hour ago" },
  { id: "act_4", user: "Sarah Connor", action: "invited team member", target: "Bob Wilson", time: "2 hours ago" },
  { id: "act_5", user: "System", action: "completed campaign", target: "APAC Q3 Churn Winback", time: "Yesterday" },
]
