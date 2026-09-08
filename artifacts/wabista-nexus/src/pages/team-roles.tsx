import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Shield, UserCog, MoreHorizontal, Trash2, Clock, Mail, Link2 } from "lucide-react"
import {
  useListMembers,
  useInviteMember,
  useUpdateMemberRole,
  useRemoveMember,
  useGetCurrentUser,
  useListInvitations,
  useRevokeInvitation,
  getListMembersQueryKey,
  getListInvitationsQueryKey,
  type Member,
  type Invitation,
  type OrganizationRole,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 4,
  admin: 3,
  manager: 2,
  agent: 1,
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<OrganizationRole>("agent")
  const inviteMember = useInviteMember()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setEmail("")
          setRole("agent")
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">
          If they already have a Wabista Nexus account, they're added right away. Otherwise we'll hold a pending invitation that turns into membership automatically the moment they sign up.
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            inviteMember.mutate(
              { data: { email, role } },
              {
                onSuccess: (result: any) => {
                  queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() })
                  queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() })
                  toast({
                    title: result?.member
                      ? "Member added to workspace"
                      : "Invitation saved — they'll join automatically once they sign up",
                  })
                  onOpenChange(false)
                },
                onError: () => {
                  toast({ title: "Failed to invite member", variant: "destructive" })
                },
              }
            )
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              data-testid="input-invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrganizationRole)}>
              <SelectTrigger data-testid="select-invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={inviteMember.isPending} data-testid="button-submit-invite">
              {inviteMember.isPending ? "Sending..." : "Send Invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function TeamRoles() {
  const { data: members, isLoading } = useListMembers()
  const { data: currentUser } = useGetCurrentUser()
  const updateRole = useUpdateMemberRole()
  const removeMember = useRemoveMember()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidateMembers = () =>
    queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() })

  const [inviteOpen, setInviteOpen] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [revoking, setRevoking] = useState<Invitation | null>(null)

  const me = members?.find((m) => m.isSelf)
  const myRank = me ? ROLE_RANK[me.role] : 0
  const canManage = myRank >= ROLE_RANK.admin

  const { data: invitations } = useListInvitations({
    query: { enabled: canManage, queryKey: getListInvitationsQueryKey() },
  })
  const revokeInvitation = useRevokeInvitation()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  const handleCopyInviteLink = (invitation: Invitation) => {
    const url = `${window.location.origin}${basePath}/invite/${invitation.token}`
    navigator.clipboard.writeText(url).then(
      () => toast({ title: "Invite link copied", description: "Share it with the person you invited." }),
      () => toast({ title: "Couldn't copy link", variant: "destructive" }),
    )
  }

  const handleRevoke = () => {
    if (!revoking) return
    revokeInvitation.mutate(
      { invitationId: revoking.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() })
          toast({ title: "Invitation revoked" })
          setRevoking(null)
        },
        onError: () => toast({ title: "Failed to revoke invitation", variant: "destructive" }),
      }
    )
  }

  const handleRoleChange = (member: Member, role: OrganizationRole) => {
    updateRole.mutate(
      { memberId: member.id, data: { role } },
      {
        onSuccess: () => {
          invalidateMembers()
          toast({ title: `${member.name}'s role updated to ${role}` })
        },
        onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
      }
    )
  }

  const handleRemove = () => {
    if (!removing) return
    removeMember.mutate(
      { memberId: removing.id },
      {
        onSuccess: () => {
          invalidateMembers()
          toast({ title: "Member removed" })
          setRemoving(null)
        },
        onError: () => toast({ title: "Failed to remove member", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team & Roles</h1>
          <p className="text-muted-foreground">Manage workspace access and member permissions.</p>
        </div>
        {canManage && (
          <Button className="gap-2" data-testid="button-invite-member" onClick={() => setInviteOpen(true)}>
            <Plus className="h-4 w-4" />
            Invite Member
          </Button>
        )}
      </div>

      <div className="grid md:grid-cols-4 gap-6">
        <div className="md:col-span-3 space-y-4">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 4 : 3} className="text-center text-muted-foreground py-8">
                      Loading team...
                    </TableCell>
                  </TableRow>
                )}
                {(members ?? []).map((member) => {
                  const isOnlyOwner =
                    member.role === "owner" && (members ?? []).filter((m) => m.role === "owner").length <= 1
                  const canEditThisMember = canManage && !member.isSelf && (myRank >= ROLE_RANK[member.role] || member.role !== "owner")
                  const canChangeToOwner = me?.role === "owner"
                  // Only an Owner may remove another Owner (mirrors the server-side check).
                  const canRemoveThisMember = canManage && !member.isSelf && !isOnlyOwner && (member.role !== "owner" || me?.role === "owner")

                  return (
                    <TableRow key={member.id} data-testid={`row-member-${member.id}`}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                            {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-medium text-foreground">
                              {member.name} {member.isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{member.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {canEditThisMember && !isOnlyOwner ? (
                          <Select
                            value={member.role}
                            onValueChange={(v) => handleRoleChange(member, v as OrganizationRole)}
                          >
                            <SelectTrigger className="w-32 h-8" data-testid={`select-role-${member.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {canChangeToOwner && <SelectItem value="owner">Owner</SelectItem>}
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="manager">Manager</SelectItem>
                              <SelectItem value="agent">Agent</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="flex items-center gap-1.5 text-sm capitalize">
                            {member.role === 'owner' || member.role === 'admin' ? <Shield className="h-3.5 w-3.5 text-primary" /> : <UserCog className="h-3.5 w-3.5 text-muted-foreground" />}
                            <span className="font-medium">{member.role}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(member.createdAt).toLocaleDateString()}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          {canRemoveThisMember && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" data-testid={`button-member-actions-${member.id}`}>
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setRemoving(member)}
                                  data-testid={`button-remove-member-${member.id}`}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> Remove
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>

          {canManage && (invitations?.length ?? 0) > 0 && (
            <Card>
              <div className="px-4 pt-4 pb-2">
                <h3 className="font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" /> Pending Invitations
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  They'll join automatically with the assigned role the moment they sign up.
                </p>
              </div>
              <Table>
                <TableBody>
                  {invitations!.map((invitation) => (
                    <TableRow key={invitation.id} data-testid={`row-invitation-${invitation.id}`}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                            <Mail className="h-4 w-4" />
                          </div>
                          <div className="text-sm text-foreground">{invitation.email}</div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm capitalize text-muted-foreground">{invitation.role}</TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid={`button-copy-invite-link-${invitation.id}`}
                          onClick={() => handleCopyInviteLink(invitation)}
                          title="Copy invite link"
                        >
                          <Link2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid={`button-revoke-invitation-${invitation.id}`}
                          onClick={() => setRevoking(invitation)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="font-semibold text-lg">Role Permissions</h3>
          <Card className="p-4 space-y-4 text-sm">
            <div>
              <div className="font-bold flex items-center gap-2 mb-1"><Shield className="h-4 w-4 text-primary" /> Owner</div>
              <p className="text-muted-foreground text-xs leading-relaxed">Full access to all settings, billing, and API keys. Cannot be removed as the last owner.</p>
            </div>
            <div className="h-px bg-border"></div>
            <div>
              <div className="font-bold flex items-center gap-2 mb-1"><Shield className="h-4 w-4 text-primary" /> Admin</div>
              <p className="text-muted-foreground text-xs leading-relaxed">Can manage team members, settings, and campaigns.</p>
            </div>
            <div className="h-px bg-border"></div>
            <div>
              <div className="font-bold flex items-center gap-2 mb-1"><UserCog className="h-4 w-4 text-muted-foreground" /> Manager</div>
              <p className="text-muted-foreground text-xs leading-relaxed">Can create/edit campaigns, contacts, numbers, and templates.</p>
            </div>
            <div className="h-px bg-border"></div>
            <div>
              <div className="font-bold flex items-center gap-2 mb-1"><UserCog className="h-4 w-4 text-muted-foreground" /> Agent</div>
              <p className="text-muted-foreground text-xs leading-relaxed">Read-only access to workspace data.</p>
            </div>
          </Card>
        </div>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.name} will lose access to this workspace immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove} data-testid="button-confirm-remove-member">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.email} will no longer join this workspace automatically when they sign up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke} data-testid="button-confirm-revoke-invitation">
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
