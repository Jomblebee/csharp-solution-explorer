using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Tasks.Commands.CreateTask;
using TaskFlow.Domain.Enums;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.Application.Tasks;

public class CreateTaskCommandHandlerTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Fact]
    public async Task Handle_ValidCommand_CreatesTaskWithCorrectStatus()
    {
        await using var context = CreateContext(nameof(Handle_ValidCommand_CreatesTaskWithCorrectStatus));
        var handler = new CreateTaskCommandHandler(context);

        var id = await handler.Handle(
            new CreateTaskCommand(1, "Implement feature", null, Priority.High), default);

        var task = await context.Tasks.FindAsync(id);
        Assert.NotNull(task);
        Assert.Equal("Implement feature", task.Title);
        Assert.Equal(AppTaskStatus.Todo, task.Status);
        Assert.Equal(Priority.High, task.Priority);
    }

    [Fact]
    public void Validator_EmptyTitle_FailsValidation()
    {
        var validator = new CreateTaskCommandValidator();
        var result = validator.Validate(new CreateTaskCommand(1, string.Empty, null, Priority.Medium));
        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == "Title");
    }

    [Fact]
    public void Validator_InvalidProjectId_FailsValidation()
    {
        var validator = new CreateTaskCommandValidator();
        var result = validator.Validate(new CreateTaskCommand(0, "Valid title", null, Priority.Medium));
        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == "ProjectId");
    }
}
