------------------------- MODULE ReadDeclarationRefusal -------------------------
\* Validation order of a read call's declaration argument: the first-error
\* latch, then the native type check, then the range check, and only then any
\* arithmetic, cursor movement or assignment.
\*
\* Argument kinds: "inrange" (a Number the declaration admits), "outrange"
\* (a Number it does not), "foreign" (a BigInt, a Symbol, an object that does
\* not coerce). With CoerceFirst = TRUE the arithmetic runs ahead of the type
\* check (the reversed ordering), and a foreign argument makes it throw.
EXTENDS Naturals

CONSTANT CoerceFirst, MaxCalls

VARIABLES err,        \* "none" or the first latched reason
          cursor,     \* bits consumed
          assigned,   \* count of destination assignments
          threw,      \* TRUE once a call threw
          calls

Kinds == {"inrange", "outrange", "foreign"}
Reasons == {"none", "past_end", "value_out_of_range"}

Init == /\ err = "none" /\ cursor = 0 /\ assigned = 0 /\ threw = FALSE /\ calls = 0

\* a call whose declaration is of kind k
Call(k) ==
  /\ calls < MaxCalls
  /\ calls' = calls + 1
  /\ IF err /= "none"
        THEN UNCHANGED <<err, cursor, assigned, threw>>      \* latch: echo
     ELSE IF CoerceFirst /\ k = "foreign"
        THEN /\ threw' = TRUE /\ UNCHANGED <<err, cursor, assigned>>
     ELSE IF k /= "inrange"
        THEN /\ err' = "value_out_of_range"
             /\ UNCHANGED <<cursor, assigned, threw>>
     ELSE /\ cursor' = cursor + 1 /\ assigned' = assigned + 1
             /\ UNCHANGED <<err, threw>>

\* the outside event: the data runs out and latches past_end
PastEnd ==
  /\ calls < MaxCalls /\ err = "none"
  /\ err' = "past_end" /\ calls' = calls + 1
  /\ UNCHANGED <<cursor, assigned, threw>>

\* the call budget is spent: the model rests
Done == calls = MaxCalls /\ UNCHANGED <<err, cursor, assigned, threw, calls>>

Next == (\E k \in Kinds : Call(k)) \/ PastEnd \/ Done

Spec == Init /\ [][Next]_<<err, cursor, assigned, threw, calls>>

TypeOK == err \in Reasons /\ cursor \in Nat /\ assigned \in Nat /\ threw \in BOOLEAN

\* a declaration never throws
NeverThrows == ~threw
\* a refusal moves nothing: every successful call both moved the cursor and
\* assigned, one for one, and a latched stream moves nothing further
CursorTracksAssignment == cursor = assigned
\* the latch is monotone: once set, only the first reason stands
LatchStable == [][err /= "none" => err' = err]_<<err, cursor, assigned, threw, calls>>
FrozenAfterLatch == [][err /= "none" => (cursor' = cursor /\ assigned' = assigned)]_<<err, cursor, assigned, threw, calls>>
=============================================================================
