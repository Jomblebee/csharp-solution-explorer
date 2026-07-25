using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Tasks.Commands.DeleteTask;
using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Exceptions;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.Application.Tasks;

public class DeleteTaskCommandHandlerTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Fact]
    public async Task Handle_ExistingTask_RemovesTask()
    {
        await using var context = CreateContext(nameof(Handle_ExistingTask_RemovesTask));
        var task = new AppTask { Title = "To delete" };
        context.Tasks.Add(task);
        await context.SaveChangesAsync();
        var handler = new DeleteTaskCommandHandler(context);

        await handler.Handle(new DeleteTaskCommand(task.Id), default);

        Assert.Null(await context.Tasks.FindAsync(task.Id));
    }

    [Fact]
    public async Task Handle_MissingTask_ThrowsDomainException()
    {
        await using var context = CreateContext(nameof(Handle_MissingTask_ThrowsDomainException));
        var handler = new DeleteTaskCommandHandler(context);

        await Assert.ThrowsAsync<DomainException>(() =>
            handler.Handle(new DeleteTaskCommand(404), default));
    }

    // Demonstrates the skipped (yellow) state in the Test Explorer.
    [Fact(Skip = "Demo: shows the skipped state in the Test Explorer.")]
    public void Skipped_Demo()
    {
        Assert.True(false);
    }

    // Deliberately failing: demonstrates the red state plus message/stack-trace rendering.
    [Fact]
    public void Intentional_Failure_ForExplorerRedState()
    {
        Assert.Equal(42, 40 + 1);
    }
}
