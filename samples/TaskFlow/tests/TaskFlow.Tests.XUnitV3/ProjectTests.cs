using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Projects.Commands.DeleteProject;
using TaskFlow.Application.Tasks.Queries.GetTasksByProject;
using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Exceptions;
using TaskFlow.Infrastructure.Persistence;
using Xunit;

namespace TaskFlow.Tests.XUnitV3;

public class ProjectTests
{
    private static TaskFlowDbContext CreateContext(string dbName)
    {
        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseInMemoryDatabase(dbName)
            .Options;
        return new TaskFlowDbContext(options);
    }

    [Fact]
    public async Task DeleteProject_Existing_RemovesProject()
    {
        await using var context = CreateContext(nameof(DeleteProject_Existing_RemovesProject));
        var project = new Project { Name = "Doomed" };
        context.Projects.Add(project);
        await context.SaveChangesAsync();
        var handler = new DeleteProjectCommandHandler(context);

        await handler.Handle(new DeleteProjectCommand(project.Id), default);

        Assert.Null(await context.Projects.FindAsync(project.Id));
    }

    [Fact]
    public async Task DeleteProject_Missing_ThrowsDomainException()
    {
        await using var context = CreateContext(nameof(DeleteProject_Missing_ThrowsDomainException));
        var handler = new DeleteProjectCommandHandler(context);

        await Assert.ThrowsAsync<DomainException>(() =>
            handler.Handle(new DeleteProjectCommand(123), default));
    }

    // Data-driven: only tasks of the requested project are returned.
    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 1)]
    public async Task GetTasksByProject_ReturnsOnlyMatchingTasks(int projectId, int expectedCount)
    {
        await using var context = CreateContext($"{nameof(GetTasksByProject_ReturnsOnlyMatchingTasks)}_{projectId}");
        context.Tasks.AddRange(
            new AppTask { Title = "P1-a", ProjectId = 1 },
            new AppTask { Title = "P1-b", ProjectId = 1 },
            new AppTask { Title = "P2-a", ProjectId = 2 });
        await context.SaveChangesAsync();
        var handler = new GetTasksByProjectQueryHandler(context);

        var result = await handler.Handle(new GetTasksByProjectQuery(projectId), default);

        Assert.Equal(expectedCount, result.Count);
    }

    // Demonstrates the skipped (yellow) state in the Test Explorer.
    [Fact(Skip = "Demo: shows the skipped state in the Test Explorer.")]
    public void Skipped_Demo()
    {
        Assert.Fail("should not run");
    }

    // Deliberately failing: demonstrates the red state plus message/stack-trace rendering.
    [Fact]
    public void Intentional_Failure_ForExplorerRedState()
    {
        Assert.Equal(42, 40 + 1);
    }
}
