------------------------- MODULE ReadDeclarationRefusal -------------------------
\* Validation order of one read call's declaration argument.
\*
\* The call judges, in order: the first-error latch, then the native type,
\* then the range. Only an argument that passes all three reaches arithmetic,
\* and only that arithmetic moves the cursor and assigns the destination.
\*
\* Argument kinds: "inrange" (a Number the declaration admits), "outrange"
\* (a Number it does not), "foreign" (a BigInt, a Symbol, or an object that
\* does not coerce). CoerceFirst runs the arithmetic before the type check,
\* which is the reversed ordering: a foreign argument throws.
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

\* one call whose declaration is of kind k
Call(k) ==
  /\ calls < MaxCalls
  /\ calls' = calls + 1
  /\ IF err /= "none"
        THEN UNCHANGED <<err, cursor, assigned, threw>>
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

\* the call budget is spent: the model rests, so checking terminates
Done == calls = MaxCalls /\ UNCHANGED <<err, cursor, assigned, threw, calls>>

Next == (\E k \in Kinds : Call(k)) \/ PastEnd \/ Done

Spec == Init /\ [][Next]_<<err, cursor, assigned, threw, calls>>

TypeOK == err \in Reasons /\ cursor \in Nat /\ assigned \in Nat /\ threw \in BOOLEAN

\* a declaration never throws
NeverThrows == ~threw
\* a refusal moves nothing: every accepted call moved the cursor and assigned,
\* one for one
CursorTracksAssignment == cursor = assigned
\* the latch is monotone: once set, only the first reason stands, and a
\* latched stream moves nothing further
LatchStable == [][err /= "none" => err' = err]_<<err, cursor, assigned, threw, calls>>
FrozenAfterLatch == [][err /= "none" => (cursor' = cursor /\ assigned' = assigned)]_<<err, cursor, assigned, threw, calls>>
=============================================================================
