import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { automations } from "@/lib/mock-data"
import { Plus, MoreHorizontal, ArrowRight, ActivitySquare } from "lucide-react"

export default function Automations() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automations</h1>
          <p className="text-muted-foreground">Configure rules to trigger messages based on events or keywords.</p>
        </div>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Create Rule
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule Name</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Triggered</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {automations.map((rule) => (
              <TableRow key={rule.id} className="group">
                <TableCell className="font-medium">{rule.name}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-sm">
                    <ActivitySquare className="h-4 w-4 text-muted-foreground" />
                    {rule.trigger}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  <span className="bg-muted px-1.5 py-0.5 rounded text-foreground">{rule.condition}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-sm">
                    <ArrowRight className="h-3 w-3 text-primary" />
                    {rule.action}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={rule.status === 'Active' ? 'success' : 'secondary'}>
                    {rule.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {rule.lastTriggered}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
