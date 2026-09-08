import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { threads } from "@/lib/mock-data"
import { Search, Send, User, CheckCircle2, Clock } from "lucide-react"

export default function Inbox() {
  const activeThread = threads[0]

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground">Handle manual replies and customer support conversations.</p>
      </div>

      <Card className="flex-1 flex overflow-hidden border-border bg-background">
        {/* Thread List */}
        <div className="w-full md:w-1/3 md:min-w-[300px] border-r flex flex-col bg-slate-50/50 dark:bg-slate-900/50">
          <div className="p-4 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search messages..." className="pl-9 bg-background" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {threads.map((thread, i) => (
              <div 
                key={thread.threadId} 
                className={`p-4 border-b cursor-pointer hover:bg-muted/50 transition-colors ${i === 0 ? 'bg-primary/5 dark:bg-primary/10 border-l-4 border-l-primary' : 'border-l-4 border-l-transparent'}`}
              >
                <div className="flex justify-between items-start mb-1">
                  <div className="font-semibold text-sm truncate pr-2">{thread.contactName}</div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                    {thread.time}
                  </div>
                </div>
                <div className="text-xs font-mono text-muted-foreground mb-2">{thread.phone}</div>
                <div className="flex justify-between items-center">
                  <p className="text-sm text-muted-foreground line-clamp-1 flex-1 pr-4">
                    {thread.lastMessage}
                  </p>
                  {thread.unread > 0 && (
                    <Badge variant="default" className="h-5 w-5 rounded-full p-0 flex items-center justify-center shrink-0">
                      {thread.unread}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Thread View */}
        <div className="hidden md:flex flex-1 flex-col bg-background">
          {/* Thread Header */}
          <div className="h-16 border-b flex items-center justify-between px-6 bg-card">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                {activeThread.contactName.charAt(0)}
              </div>
              <div>
                <div className="font-semibold">{activeThread.contactName}</div>
                <div className="text-xs text-muted-foreground font-mono">{activeThread.phone}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Resolve
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <User className="h-4 w-4" />
                Profile
              </Button>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 p-6 overflow-y-auto space-y-6 bg-slate-50/30 dark:bg-slate-900/20">
            {/* System Message */}
            <div className="flex justify-center">
              <div className="bg-muted px-3 py-1 rounded-full text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Conversation started today at 09:41 AM
              </div>
            </div>

            {/* Inbound Message */}
            <div className="flex gap-3">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0 mt-auto">
                {activeThread.contactName.charAt(0)}
              </div>
              <div className="bg-card border shadow-sm rounded-2xl rounded-bl-sm p-3 max-w-[80%]">
                <p className="text-sm">Hi, I recently received an email about the Black Friday sale. Can you confirm if my account is eligible for the VIP tier?</p>
                <div className="text-[10px] text-muted-foreground text-right mt-1">09:41 AM</div>
              </div>
            </div>

            {/* Outbound Message */}
            <div className="flex gap-3 flex-row-reverse">
              <div className="h-8 w-8 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-foreground font-bold shrink-0 mt-auto">
                SC
              </div>
              <div className="bg-primary text-primary-foreground shadow-sm rounded-2xl rounded-br-sm p-3 max-w-[80%]">
                <p className="text-sm">Hello Sarah! I'd be happy to check that for you. Give me one moment.</p>
                <div className="text-[10px] text-primary-foreground/70 text-right mt-1">09:43 AM</div>
              </div>
            </div>
            
            {/* Outbound Message */}
            <div className="flex gap-3 flex-row-reverse">
              <div className="w-8 shrink-0"></div> {/* Spacer for avatar alignment */}
              <div className="bg-primary text-primary-foreground shadow-sm rounded-2xl rounded-br-sm p-3 max-w-[80%]">
                <p className="text-sm">Yes, I can confirm your account has been upgraded to VIP. You'll have early access starting tomorrow!</p>
                <div className="text-[10px] text-primary-foreground/70 text-right mt-1">09:45 AM</div>
              </div>
            </div>

            {/* Inbound Message (The latest one) */}
            <div className="flex gap-3">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0 mt-auto">
                {activeThread.contactName.charAt(0)}
              </div>
              <div className="bg-card border shadow-sm rounded-2xl rounded-bl-sm p-3 max-w-[80%]">
                <p className="text-sm">{activeThread.lastMessage}</p>
                <div className="text-[10px] text-muted-foreground text-right mt-1">2m ago</div>
              </div>
            </div>
          </div>

          {/* Reply Area */}
          <div className="p-4 bg-card border-t">
            <div className="flex gap-2">
              <Input placeholder="Type your message..." className="flex-1 bg-background" />
              <Button size="icon" className="shrink-0">
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2 text-xs text-muted-foreground flex justify-between">
              <span>Press Enter to send, Shift+Enter for new line</span>
              <span>Sending as: +1 (555) 019-2831</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
