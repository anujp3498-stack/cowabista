import { useQueryClient } from "@tanstack/react-query"
import { getListPhoneNumbersQueryKey, useDeletePhoneNumber, type PhoneNumber } from "@workspace/api-client-react"
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
import { useToast } from "@/hooks/use-toast"
import { messageFrom } from "@/lib/api-errors"

// Removing a number here only forgets it in Wabista. It does not touch the
// number at Meta, and the wording says so.
export function RemoveNumberDialog({
  phoneNumber,
  onOpenChange,
}: {
  phoneNumber: PhoneNumber | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const remove = useDeletePhoneNumber()

  const confirm = () => {
    if (!phoneNumber) return
    remove.mutate(
      { phoneNumberId: phoneNumber.id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })
          toast({ title: "Number removed from Wabista" })
          onOpenChange(false)
        },
        onError: (error) => toast({ title: messageFrom(error, "Couldn't remove this number"), variant: "destructive" }),
      },
    )
  }

  return (
    <AlertDialog open={phoneNumber !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from Wabista?</AlertDialogTitle>
          <AlertDialogDescription>
            {phoneNumber ? `${phoneNumber.displayName} (${phoneNumber.phone})` : "This number"} will no longer appear in this
            workspace and can't be used in campaigns. Nothing changes at Meta; you can connect it again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Keep number</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              confirm()
            }}
            disabled={remove.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="button-confirm-remove-number"
          >
            {remove.isPending ? "Removing…" : "Remove from Wabista"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
