# Workflow Patterns

Patterns for structuring multi-step processes in skills.

## Sequential Workflows

For complex tasks, break operations into clear, ordered steps. Give Claude an overview at the beginning:

```markdown
Filling a PDF form involves these steps:

1. Analyze the form structure
2. Map data to form fields
3. Validate the mapping
4. Fill the form
5. Verify the output
```

### With Tool References

When steps involve specific tools or commands:

```markdown
## Image Processing Workflow

1. **Load image** - Read with PIL/Pillow
2. **Analyze dimensions** - Check size constraints
3. **Transform** - Apply requested modifications
4. **Optimize** - Compress for target format
5. **Save** - Write to output path
```

## Conditional Workflows

For tasks with branching logic, guide through decision points:

```markdown
## Document Modification

1. Determine the modification type:
   - **Creating new content?** → Follow "Creation workflow" below
   - **Editing existing content?** → Follow "Editing workflow" below

### Creation Workflow
1. Choose document template
2. Structure content sections
3. Apply formatting
4. Generate output

### Editing Workflow
1. Parse existing document
2. Locate target sections
3. Apply modifications
4. Preserve formatting
5. Save changes
```

## Decision Tree Pattern

For complex decision-making with multiple branches:

```markdown
## Workflow Decision Tree

1. **Is this a new document or existing?**
   - New → Go to "Creating Documents"
   - Existing → Continue to step 2

2. **What operation is needed?**
   - Read/extract text → Go to "Reading Documents"
   - Modify content → Go to "Editing Documents"
   - Add comments → Go to "Commenting"

3. **Does it need tracked changes?**
   - Yes → Go to "Track Changes Mode"
   - No → Continue with standard edit
```

## Iterative Workflows

For tasks requiring refinement:

```markdown
## Code Optimization

1. **Profile** - Identify performance bottlenecks
2. **Analyze** - Understand root cause
3. **Optimize** - Apply targeted fix
4. **Measure** - Verify improvement
5. **Repeat** - If targets not met, return to step 1
```

## Parallel Workflows

When steps can be done independently:

```markdown
## Project Setup

Execute these independently:

**Track A: Dependencies**
1. Initialize package manager
2. Install dependencies
3. Verify installation

**Track B: Configuration**
1. Create config files
2. Set environment variables
3. Validate configuration

**Track C: Structure**
1. Create directory structure
2. Add boilerplate files
3. Initialize git

Then: Verify all tracks complete before proceeding.
```

## Error Recovery Workflows

For handling failures gracefully:

```markdown
## Data Import

1. **Parse input file**
   - On parse error → Log error, skip malformed rows, continue
   
2. **Validate records**
   - On validation failure → Add to error report, continue
   
3. **Import valid records**
   - On import failure → Rollback batch, retry with smaller batch
   
4. **Generate report**
   - Success count, failure count, error details
```
