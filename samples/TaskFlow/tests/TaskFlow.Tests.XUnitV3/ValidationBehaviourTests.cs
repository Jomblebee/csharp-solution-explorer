using FluentValidation;
using MediatR;
using TaskFlow.Application.Common.Behaviours;
using TaskFlow.Application.Projects.Commands.CreateProject;
using Xunit;

namespace TaskFlow.Tests.XUnitV3;

public class ValidationBehaviourTests
{
    [Fact]
    public async Task Handle_InvalidRequest_ThrowsValidationException()
    {
        var behaviour = new ValidationBehaviour<CreateProjectCommand, int>(
            [new CreateProjectCommandValidator()]);
        RequestHandlerDelegate<int> next = _ => Task.FromResult(1);

        await Assert.ThrowsAsync<ValidationException>(() =>
            behaviour.Handle(new CreateProjectCommand(string.Empty, null), next, default));
    }

    [Fact]
    public async Task Handle_ValidRequest_CallsNext()
    {
        var behaviour = new ValidationBehaviour<CreateProjectCommand, int>(
            [new CreateProjectCommandValidator()]);
        RequestHandlerDelegate<int> next = _ => Task.FromResult(7);

        var result = await behaviour.Handle(new CreateProjectCommand("Valid", null), next, default);

        Assert.Equal(7, result);
    }
}
