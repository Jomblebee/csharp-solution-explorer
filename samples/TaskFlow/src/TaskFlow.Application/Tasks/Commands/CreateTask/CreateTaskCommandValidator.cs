using FluentValidation;

namespace TaskFlow.Application.Tasks.Commands.CreateTask;

public class CreateTaskCommandValidator : AbstractValidator<CreateTaskCommand>
{
    public CreateTaskCommandValidator()
    {
        RuleFor(x => x.Title)
            .NotEmpty().WithMessage("Task title is required.")
            .MaximumLength(300);

        RuleFor(x => x.ProjectId)
            .GreaterThan(0).WithMessage("A valid project must be specified.");
    }
}
