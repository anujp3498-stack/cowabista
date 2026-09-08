import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { invoices } from "@/lib/mock-data"
import { formatCurrency } from "@/lib/utils"
import { Download, CreditCard, CheckCircle2 } from "lucide-react"

export default function Billing() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Billing & Usage</h1>
        <p className="text-muted-foreground">Manage your plan, limits, and view invoice history.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2 border-primary/50 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-6 opacity-5 pointer-events-none">
            <CreditCard className="w-32 h-32" />
          </div>
          <CardHeader>
            <div className="flex justify-between items-start">
              <div>
                <CardTitle className="text-2xl flex items-center gap-2">Enterprise Tier <Badge className="bg-primary/20 text-primary border-none">Current Plan</Badge></CardTitle>
                <CardDescription className="mt-2 text-base">You are on the custom high-volume plan.</CardDescription>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold">$4,500<span className="text-base font-normal text-muted-foreground">/mo</span></div>
                <div className="text-sm text-muted-foreground mt-1">Base + Usage</div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span>Message Volume (This Month)</span>
                <span>8.5M / 10M included</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary" style={{ width: '85%' }}></div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4 pt-4 border-t">
              <div>
                <div className="text-sm text-muted-foreground font-medium">Additional Messages</div>
                <div className="text-lg font-bold">$0.001 / msg</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground font-medium">Max TPS Limit</div>
                <div className="text-lg font-bold">5,000 / sec</div>
              </div>
            </div>
          </CardContent>
          <CardFooter className="bg-slate-50 dark:bg-slate-900/50 border-t py-4">
            <Button variant="outline">Contact Sales for Upgrade</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment Method</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4 p-4 border rounded-lg bg-card">
              <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded">
                <CreditCard className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">•••• •••• •••• 4242</div>
                <div className="text-xs text-muted-foreground">Expires 12/25</div>
              </div>
              <Badge variant="outline" className="border-emerald-500 text-emerald-600 dark:text-emerald-400">Default</Badge>
            </div>
            <Button variant="outline" className="w-full">Update Method</Button>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Invoice History</h2>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice ID</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Billing Period</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-sm">{inv.id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{inv.date}</TableCell>
                  <TableCell className="font-medium">{inv.period}</TableCell>
                  <TableCell className="font-mono">{formatCurrency(inv.amount)}</TableCell>
                  <TableCell>
                    <Badge variant={inv.status === 'Paid' ? 'success' : 'secondary'} className="gap-1">
                      {inv.status === 'Paid' && <CheckCircle2 className="h-3 w-3" />}
                      {inv.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon">
                      <Download className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  )
}
