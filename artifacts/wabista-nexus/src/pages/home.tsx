import { Link } from "wouter"
import { Button } from "@/components/ui/button"
import {
  ArrowRight,
  Gauge,
  Network,
  Rocket,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react"

const features = [
  {
    icon: Rocket,
    title: "Rocket Campaign Engine",
    description:
      "Partition massive audiences and route them across multiple WABA numbers simultaneously, avoiding provider rate limits.",
  },
  {
    icon: Network,
    title: "Multi-Route Delivery",
    description:
      "Dynamic routing balances load across connected WhatsApp Business Accounts with real-time TPS enforcement.",
  },
  {
    icon: Users,
    title: "Workspaces & Roles",
    description:
      "Every organization gets its own isolated workspace with Owner, Admin, Manager, and Agent roles.",
  },
  {
    icon: ShieldCheck,
    title: "Approved Templates",
    description:
      "Manage pre-approved WhatsApp templates and keep your messaging compliant across every campaign.",
  },
]

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 overflow-hidden">
      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-primary text-primary-foreground">
            <Rocket className="h-4 w-4" />
          </div>
          Wabista Nexus
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/sign-in"
            data-testid="link-sign-in"
            className="inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            data-testid="link-sign-up"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            Get started
          </Link>
        </div>
      </header>

      <main className="relative">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-slate-950 to-slate-950 opacity-70" />

        <section className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-6 pb-20 pt-16 text-center sm:pt-24">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1 text-xs font-mono text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            NOC STATUS: ALL SYSTEMS OPERATIONAL
          </div>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
            The command center for WhatsApp at scale
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-slate-400">
            Wabista Nexus unifies contacts, phone numbers, templates, and multi-route
            campaign delivery into one telecom-grade messaging platform &mdash; built for
            teams running large WhatsApp campaigns reliably.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/sign-up"
              data-testid="link-hero-get-started"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
            >
              Create your workspace <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/sign-in"
              data-testid="link-hero-sign-in"
              className="inline-flex h-11 items-center justify-center rounded-md border border-slate-700 bg-slate-900/60 px-6 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800"
            >
              Sign in to your account
            </Link>
          </div>
        </section>

        <section className="relative z-10 mx-auto grid max-w-6xl gap-6 px-6 pb-24 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur"
            >
              <feature.icon className="mb-4 h-8 w-8 text-primary" />
              <h3 className="mb-2 text-base font-semibold">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">
                {feature.description}
              </p>
            </div>
          ))}
        </section>

        <section className="relative z-10 mx-auto max-w-4xl px-6 pb-24">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-primary/30 bg-primary/10 p-10 text-center sm:flex-row sm:justify-between sm:text-left">
            <div>
              <div className="flex items-center gap-2 text-primary">
                <Gauge className="h-5 w-5" />
                <span className="font-mono text-xs uppercase tracking-wider">
                  Ready when you are
                </span>
              </div>
              <h2 className="mt-2 text-2xl font-bold">
                Spin up a workspace with sample data in seconds
              </h2>
              <p className="mt-2 max-w-md text-sm text-slate-400">
                Every new account gets a personal workspace pre-seeded with demo
                contacts, numbers, and templates so you can explore immediately.
              </p>
            </div>
            <Link
              href="/sign-up"
              data-testid="link-cta-get-started"
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
            >
              <Zap className="h-4 w-4" /> Get started free
            </Link>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-slate-900 px-6 py-8 text-center text-xs text-slate-500">
        Wabista Nexus &mdash; a demonstration of workspace-scoped WhatsApp campaign
        infrastructure.
      </footer>
    </div>
  )
}
